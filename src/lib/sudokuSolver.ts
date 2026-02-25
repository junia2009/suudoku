// 数独ソルバーのロジック（バックトラッキング方式）
export type SudokuBoard = number[][]; // 9x9 の配列、空欄は 0

/**
 * 盤面を解く（破壊的に変更される）
 * @returns 解けたら true
 */
export function solveSudoku(board: SudokuBoard): boolean {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (board[row][col] === 0) {
        for (let num = 1; num <= 9; num++) {
          if (isValid(board, row, col, num)) {
            board[row][col] = num;
            if (solveSudoku(board)) return true;
            board[row][col] = 0;
          }
        }
        return false;
      }
    }
  }
  return true;
}

/**
 * 盤面の初期状態が矛盾していないかチェック
 * @returns 矛盾がなければ true
 */
export function validateBoard(board: SudokuBoard): boolean {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const num = board[row][col];
      if (num !== 0) {
        // 一時的に空にしてから検証
        board[row][col] = 0;
        const valid = isValid(board, row, col, num);
        board[row][col] = num;
        if (!valid) return false;
      }
    }
  }
  return true;
}

function isValid(board: SudokuBoard, row: number, col: number, num: number): boolean {
  for (let i = 0; i < 9; i++) {
    if (board[row][i] === num || board[i][col] === num) return false;
  }
  const startRow = Math.floor(row / 3) * 3;
  const startCol = Math.floor(col / 3) * 3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (board[startRow + i][startCol + j] === num) return false;
    }
  }
  return true;
}

/**
 * 空の 9x9 盤面を生成
 */
export function createEmptyBoard(): SudokuBoard {
  return Array.from({ length: 9 }, () => Array(9).fill(0));
}
