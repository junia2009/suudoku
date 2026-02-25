"use client";

import styles from "./page.module.css";
import { useRef, useState, useCallback } from "react";
import {
  solveSudoku,
  validateBoard,
  createEmptyBoard,
  SudokuBoard,
} from "@/lib/sudokuSolver";

// === grid line type ===
type GridLine = { center: number; start: number; end: number };

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  // 数独盤面
  const [board, setBoard] = useState<SudokuBoard>(createEmptyBoard());
  const [originalCells, setOriginalCells] = useState<boolean[][]>(
    Array.from({ length: 9 }, () => Array(9).fill(false))
  );
  const [solved, setSolved] = useState(false);
  const [error, setError] = useState("");
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrStatus, setOcrStatus] = useState("");

  // ---------- カメラ ----------
  const handleCameraClick = async () => {
    setCameraActive(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch {
      alert("カメラの利用が許可されていません。ブラウザの設定をご確認ください。");
      setCameraActive(false);
    }
  };

  const stopCamera = useCallback(() => {
    if (videoRef.current) {
      const stream = videoRef.current.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  const handleTakePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      setImageSrc(dataUrl);
      runOcr(dataUrl);
    }
    stopCamera();
  };

  // ---------- 画像選択 ----------
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setImageSrc(dataUrl);
      runOcr(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // =====================================================
  //  OCR パイプライン (v12: グリッド線検出 + 全体OCR + ピクセルスキャン)
  // =====================================================

  /** 画像を指定倍率で拡大してCanvasに描画 */
  const loadImageToCanvas = (
    imageDataUrl: string,
    scale: number = 4
  ): Promise<{ canvas: HTMLCanvasElement; w: number; h: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ canvas: c, w, h });
      };
      img.onerror = () => reject(new Error("画像を読み込めませんでした"));
      img.src = imageDataUrl;
    });
  };

  /** グリッド線検出: 暗ピクセル密度の高い行/列をクラスタリング */
  const detectGridLines = (
    density: number[],
    threshold: number,
    maxGap: number
  ): GridLine[] => {
    const peaks: {
      start: number;
      end: number;
      weightedSum: number;
      totalWeight: number;
    }[] = [];
    for (let i = 0; i < density.length; i++) {
      if (density[i] > threshold) {
        if (peaks.length === 0 || i - peaks[peaks.length - 1].end > maxGap) {
          peaks.push({
            start: i,
            end: i,
            weightedSum: i * density[i],
            totalWeight: density[i],
          });
        } else {
          const p = peaks[peaks.length - 1];
          p.end = i;
          p.weightedSum += i * density[i];
          p.totalWeight += density[i];
        }
      }
    }
    return peaks.map((p) => ({
      center: Math.round(p.weightedSum / p.totalWeight),
      start: p.start,
      end: p.end,
    }));
  };

  /** セルを切り出してOCR用画像を生成 */
  const cropCellImage = (
    sourceCanvas: HTMLCanvasElement,
    row: number,
    col: number,
    vLines: GridLine[],
    hLines: GridLine[]
  ): string => {
    const x0 = vLines[col].end + 1;
    const x1 = vLines[col + 1].start - 1;
    const y0 = hLines[row].end + 1;
    const y1 = hLines[row + 1].start - 1;
    const cw = x1 - x0;
    const ch = y1 - y0;
    const PAD = 40;
    const SCALE = 2;

    const cellCanvas = document.createElement("canvas");
    cellCanvas.width = (cw + PAD * 2) * SCALE;
    cellCanvas.height = (ch + PAD * 2) * SCALE;
    const cellCtx = cellCanvas.getContext("2d")!;
    cellCtx.fillStyle = "white";
    cellCtx.fillRect(0, 0, cellCanvas.width, cellCanvas.height);
    cellCtx.imageSmoothingEnabled = true;
    cellCtx.imageSmoothingQuality = "high";
    cellCtx.drawImage(
      sourceCanvas,
      x0, y0, cw, ch,
      PAD * SCALE, PAD * SCALE, cw * SCALE, ch * SCALE
    );
    return cellCanvas.toDataURL("image/png");
  };

  /** メインOCR処理 */
  const runOcr = async (imageDataUrl: string) => {
    setError("");
    setSolved(false);
    setOcrProgress(0);
    setOcrStatus("OCRエンジンを準備中...");

    try {
      // --- 1. 画像読み込み＆4x拡大 ---
      setOcrStatus("画像を前処理中...");
      const { canvas, w: W, h: H } = await loadImageToCanvas(imageDataUrl, 4);
      const ctx = canvas.getContext("2d")!;
      console.log(`Image loaded: ${W}x${H}`);

      // --- 2. グリッド線検出 ---
      setOcrStatus("グリッド線を検出中...");
      const imageData = ctx.getImageData(0, 0, W, H);
      const px = imageData.data;

      const getGray = (x: number, y: number): number => {
        const i = (y * W + x) * 4;
        return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      };

      const DARK_THRESH = 150;
      const colDark = new Array(W).fill(0);
      const rowDark = new Array(H).fill(0);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (getGray(x, y) < DARK_THRESH) {
            colDark[x]++;
            rowDark[y]++;
          }
        }
      }

      const vLines = detectGridLines(colDark, H * 0.7, 20);
      const hLines = detectGridLines(rowDark, W * 0.7, 20);
      console.log(
        `Grid lines: ${vLines.length} vertical, ${hLines.length} horizontal`
      );

      if (vLines.length < 2 || hLines.length < 2) {
        console.warn("Grid lines not detected, falling back to basic OCR");
        await runBasicOcr(imageDataUrl);
        return;
      }

      // 10本未満の場合は等間隔で補間
      const finalV = ensureGridLines(vLines, 10, W);
      const finalH = ensureGridLines(hLines, 10, H);

      // --- 3. 全体OCR ---
      setOcrStatus("文字を認識中...");
      const Tesseract = await import("tesseract.js");
      const worker = await Tesseract.createWorker("eng", 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: "123456789",
        tessedit_pageseg_mode: "6" as unknown as Tesseract.PSM,
      });

      const result = await worker.recognize(
        canvas.toDataURL("image/png"),
        {},
        { text: true, blocks: true }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lineTexts: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const block of ((result.data as any).blocks || [])) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const para of (block.paragraphs || [])) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const line of (para.lines || [])) {
            const text = (line.words || [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((w: any) => w.text)
              .join("")
              .trim();
            lineTexts.push(text.replace(/[^1-9]/g, ""));
          }
        }
      }
      console.log("OCR line texts:", lineTexts);

      // --- 4. セル暗さ計算 + マッピング ---
      setOcrStatus("数字の位置を特定中...");
      const newBoard = createEmptyBoard();

      for (let row = 0; row < 9; row++) {
        const y0 = finalH[row].end + 1;
        const y1 = finalH[row + 1].start - 1;
        const ch = y1 - y0;

        const darkness: { col: number; ratio: number }[] = [];
        for (let col = 0; col < 9; col++) {
          const x0 = finalV[col].end + 1;
          const x1 = finalV[col + 1].start - 1;
          const cw = x1 - x0;
          const mX = cw * 0.15;
          const mY = ch * 0.15;
          const sx0 = Math.round(x0 + mX);
          const sx1 = Math.round(x1 - mX);
          const sy0 = Math.round(y0 + mY);
          const sy1 = Math.round(y1 - mY);

          let darkCount = 0;
          let total = 0;
          for (let y = sy0; y <= sy1; y++) {
            for (let x = sx0; x <= sx1; x++) {
              total++;
              if (getGray(x, y) < DARK_THRESH) darkCount++;
            }
          }
          darkness.push({ col, ratio: darkCount / Math.max(1, total) });
        }

        const digitCells = darkness
          .filter((d) => d.ratio > 0.03)
          .sort((a, b) => b.ratio - a.ratio);
        const N = digitCells.length;
        if (N === 0) continue;

        const sortedCells = [...digitCells].sort((a, b) => a.col - b.col);
        const ocrText = row < lineTexts.length ? lineTexts[row] : "";
        const non1Digits = ocrText.replace(/1/g, "");

        if (non1Digits.length >= N) {
          // 非"1"数字がセル数以上 → 直接マッピング（曖昧性なし）
          for (let i = 0; i < N; i++) {
            newBoard[row][sortedCells[i].col] = parseInt(non1Digits[i], 10);
          }
          console.log(
            `Row ${row}: direct map "${non1Digits.slice(0, N)}" → [${sortedCells.map((c) => c.col).join(",")}]`
          );
        } else {
          // "1"がいくつか必要 → セルごとOCRで確定
          console.log(
            `Row ${row}: ambiguous (non1="${non1Digits}", N=${N}), running cell OCR...`
          );
          await worker.setParameters({
            tessedit_pageseg_mode: "10" as unknown as Tesseract.PSM,
          });

          for (const dc of sortedCells) {
            const cellImg = cropCellImage(canvas, row, dc.col, finalV, finalH);
            const cellResult = await worker.recognize(cellImg);
            const digit = cellResult.data.text
              .trim()
              .replace(/[^1-9]/g, "");
            if (digit.length >= 1) {
              newBoard[row][dc.col] = parseInt(digit[0], 10);
              console.log(`  Cell [${row},${dc.col}]: OCR="${digit[0]}"`);
            }
          }

          // セルOCRで読めなかったセルのフォールバック
          const assignedDigits = sortedCells
            .filter((dc) => newBoard[row][dc.col] !== 0)
            .map((dc) => String(newBoard[row][dc.col]));
          const unassignedCells = sortedCells.filter(
            (dc) => newBoard[row][dc.col] === 0
          );

          if (unassignedCells.length > 0) {
            // 全体OCRの非1数字から未割当のものを探す
            const remainingNon1 = [...non1Digits];
            for (const d of assignedDigits) {
              const idx = remainingNon1.indexOf(d);
              if (idx !== -1) remainingNon1.splice(idx, 1);
            }
            for (let i = 0; i < unassignedCells.length; i++) {
              if (i < remainingNon1.length) {
                newBoard[row][unassignedCells[i].col] = parseInt(
                  remainingNon1[i],
                  10
                );
              } else {
                newBoard[row][unassignedCells[i].col] = 1;
              }
              console.log(
                `  Cell [${row},${unassignedCells[i].col}]: fallback=${newBoard[row][unassignedCells[i].col]}`
              );
            }
          }

          // PSMを元に戻す
          await worker.setParameters({
            tessedit_pageseg_mode: "6" as unknown as Tesseract.PSM,
          });
        }
      }

      await worker.terminate();

      // 結果を設定
      const filledCount = newBoard.flat().filter((c) => c !== 0).length;
      setBoard(newBoard);
      setOriginalCells(newBoard.map((r) => r.map((c) => c !== 0)));
      setOcrStatus(
        `読み取り完了（${filledCount}個の数字を検出）！間違いがあれば手入力で修正してください。`
      );

      console.log("Final board:");
      for (let r = 0; r < 9; r++) {
        console.log(newBoard[r].map((v) => v || ".").join(" "));
      }
    } catch (err) {
      console.error("OCR Error:", err);
      setError("OCR処理中にエラーが発生しました。手入力で入力してください。");
      setOcrStatus("");
    } finally {
      setOcrProgress(null);
    }
  };

  /** グリッド線が10本未満の場合に等間隔で補間 */
  const ensureGridLines = (
    lines: GridLine[],
    expected: number,
    maxDim: number
  ): GridLine[] => {
    if (lines.length >= expected) return lines.slice(0, expected);

    // 外枠2本 + 内部線を等間隔で補間
    const first = lines[0];
    const last = lines[lines.length - 1];
    const totalSpan = last.center - first.center;
    const step = totalSpan / (expected - 1);

    const result: GridLine[] = [];
    for (let i = 0; i < expected; i++) {
      const targetCenter = Math.round(first.center + i * step);
      // 既存の線で近いものがあればそれを使う
      const existing = lines.find(
        (l) => Math.abs(l.center - targetCenter) < step * 0.3
      );
      if (existing) {
        result.push(existing);
      } else {
        result.push({ center: targetCenter, start: targetCenter, end: targetCenter });
      }
    }
    return result;
  };

  /** フォールバック: グリッド線が検出できない場合の基本OCR */
  const runBasicOcr = async (imageDataUrl: string) => {
    try {
      const Tesseract = await import("tesseract.js");
      const worker = await Tesseract.createWorker("eng", 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: "123456789",
        tessedit_pageseg_mode: "6" as unknown as Tesseract.PSM,
      });

      const result = await worker.recognize(imageDataUrl, {}, { text: true });
      await worker.terminate();

      const text = result.data.text || "";
      const lines = text
        .split("\n")
        .map((l) => l.replace(/[^1-9]/g, ""))
        .filter((l) => l.length > 0);

      if (lines.length >= 9) {
        const newBoard = createEmptyBoard();
        for (let r = 0; r < Math.min(9, lines.length); r++) {
          for (let c = 0; c < Math.min(9, lines[r].length); c++) {
            const d = parseInt(lines[r][c], 10);
            if (d >= 1 && d <= 9) newBoard[r][c] = d;
          }
        }
        const filledCount = newBoard.flat().filter((c) => c !== 0).length;
        setBoard(newBoard);
        setOriginalCells(newBoard.map((r) => r.map((c) => c !== 0)));
        setOcrStatus(
          `読み取り完了（${filledCount}個の数字を検出）。精度が低い可能性があります。手入力で修正してください。`
        );
      } else {
        setError(
          "画像から数独の数字を十分に読み取れませんでした。手入力で入力してください。"
        );
      }
    } catch (err) {
      console.error("Basic OCR Error:", err);
      setError("OCR処理中にエラーが発生しました。");
    } finally {
      setOcrProgress(null);
      setOcrStatus("");
    }
  };

  // ---------- 盤面操作 ----------
  const handleCellChange = (row: number, col: number, value: string) => {
    if (solved) return;
    const num = parseInt(value, 10);
    if (value !== "" && (isNaN(num) || num < 1 || num > 9)) return;

    const newBoard = board.map((r, i) =>
      i === row
        ? r.map((c, j) => (j === col ? (value === "" ? 0 : num) : c))
        : r
    );
    setBoard(newBoard);

    const newOrig = originalCells.map((r, i) =>
      i === row
        ? r.map((c, j) => (j === col ? value !== "" : c))
        : r
    );
    setOriginalCells(newOrig);
    setError("");
  };

  const handleSolve = () => {
    const boardCopy: SudokuBoard = board.map((row) => [...row]);

    if (!validateBoard(boardCopy)) {
      setError(
        "盤面に矛盾があります。同じ行・列・ブロックに重複がないか確認してください。"
      );
      setSolved(false);
      return;
    }

    const origMap = boardCopy.map((row) => row.map((c) => c !== 0));

    if (solveSudoku(boardCopy)) {
      setBoard(boardCopy);
      setOriginalCells(origMap);
      setSolved(true);
      setError("");
    } else {
      setError("解答できませんでした。入力内容をご確認ください。");
      setSolved(false);
    }
  };

  const handleClear = () => {
    setBoard(createEmptyBoard());
    setOriginalCells(Array.from({ length: 9 }, () => Array(9).fill(false)));
    setSolved(false);
    setError("");
    setImageSrc(null);
    setOcrStatus("");
  };

  // ---------- セルクラス名 ----------
  const cellClassName = (row: number, col: number) => {
    const classes = [styles.cell];
    if (col % 3 === 2 && col !== 8) classes.push(styles.cellBorderRight);
    if (row % 3 === 2 && row !== 8) classes.push(styles.cellBorderBottom);
    if (solved && originalCells[row][col]) classes.push(styles.cellOriginal);
    if (solved && !originalCells[row][col]) classes.push(styles.cellSolved);
    return classes.join(" ");
  };

  return (
    <div className={styles.page}>
      {/* ヘッダー */}
      <header className={styles.header}>
        <h1 className={styles.title}>🧩 数独ソルバー</h1>
        <p className={styles.subtitle}>
          手入力 or カメラ/画像で数独を自動解答！
        </p>
      </header>

      {/* 画像入力カード */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>📷 画像から読み取り</h2>
        <div className={styles.buttonRow}>
          <button
            className={`${styles.btnPrimary} ${cameraActive ? styles.btnDisabled : ""}`}
            onClick={handleCameraClick}
            disabled={cameraActive}
          >
            カメラで撮影
          </button>
          <button
            className={`${styles.btnSecondary} ${cameraActive ? styles.btnDisabled : ""}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={cameraActive}
          >
            画像を選択
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className={styles.hidden}
          onChange={handleFileChange}
          aria-label="数独画像を選択"
        />

        {/* カメラプレビュー */}
        {cameraActive && (
          <div className={styles.previewArea}>
            <video
              ref={videoRef}
              className={styles.videoPreview}
              autoPlay
              playsInline
            />
            <canvas ref={canvasRef} className={styles.hidden} />
            <div className={styles.buttonRowCenter}>
              <button className={styles.btnSuccess} onClick={handleTakePhoto}>
                📸 撮影
              </button>
              <button className={styles.btnDanger} onClick={stopCamera}>
                キャンセル
              </button>
            </div>
          </div>
        )}

        {/* OCR プログレス */}
        {ocrProgress !== null && (
          <div>
            <div className={styles.progressBar}>
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, react/forbid-dom-props */}
              <div
                className={styles.progressFill}
                style={{ width: `${ocrProgress}%` }}
              />
            </div>
            <p className={styles.infoMsg}>
              {ocrStatus} ({ocrProgress}%)
            </p>
          </div>
        )}

        {/* 画像プレビュー */}
        {imageSrc && !cameraActive && (
          <div className={styles.previewArea}>
            <img
              src={imageSrc}
              alt="アップロード画像"
              className={styles.previewImage}
            />
          </div>
        )}

        {ocrStatus && ocrProgress === null && (
          <p className={styles.successMsg}>{ocrStatus}</p>
        )}
      </div>

      {/* 数独盤面カード */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>✏️ 数独盤面</h2>

        <div className={styles.gridWrapper}>
          <div className={styles.grid}>
            {board.map((row, i) =>
              row.map((cell, j) => (
                <input
                  key={`${i}-${j}`}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={cell === 0 ? "" : cell}
                  onChange={(e) => handleCellChange(i, j, e.target.value)}
                  className={cellClassName(i, j)}
                  readOnly={solved}
                  aria-label={`セル ${i + 1}行${j + 1}列`}
                />
              ))
            )}
          </div>
        </div>

        <div className={styles.actionRow}>
          <button
            className={styles.btnSuccess}
            onClick={handleSolve}
            disabled={solved}
          >
            🚀 自動で解く
          </button>
          <button className={styles.btnDanger} onClick={handleClear}>
            🗑️ クリア
          </button>
        </div>

        {error && <p className={styles.errorMsg}>{error}</p>}
        {solved && <p className={styles.successMsg}>🎉 解答完了！</p>}
      </div>
    </div>
  );
}
