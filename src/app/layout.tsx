import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "数独ソルバー",
  description: "数独パズルを手入力またはカメラ/画像から自動で解くアプリ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
