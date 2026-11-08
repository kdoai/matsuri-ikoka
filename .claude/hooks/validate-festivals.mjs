// 祭りのデータを書き換えたら検証を走らせる Claude Code のフック（PostToolUse、Edit と Write）。
//
// 標準入力でツールの呼び出し（JSON）を受け取る。変えたファイルが data/festivals/*.json か
// data/research-ledger.json なら、そのリポジトリで `pnpm validate:data` を走らせる。
// エラーがあれば結果を標準エラーに出し、終了コード 2 で終わる（Claude に結果が届く）。
// 祭りのデータ以外なら何もしない。
//
// 設定は .claude/settings.json。テストは scripts/claude-hooks.test.ts。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 区切りは / と \ のどちらでもよい（Windows のパスも受ける）
const FESTIVAL_DATA = /^(.*)[\\/]data[\\/](?:festivals[\\/][^\\/]+\.json|research-ledger\.json)$/;

/** 祭りのデータのパスなら、そのリポジトリの根を返す。違えば null */
export function festivalDataRoot(filePath) {
  if (typeof filePath !== "string") return null;
  const match = FESTIVAL_DATA.exec(filePath);
  if (match === null || match[1] === "") return null;
  return match[1];
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return 0;
  }
  const filePath = input?.tool_input?.file_path;
  const absolute =
    typeof filePath === "string" && !path.isAbsolute(filePath) && typeof input.cwd === "string"
      ? path.resolve(input.cwd, filePath)
      : filePath;
  const root = festivalDataRoot(absolute);
  if (root === null) return 0;

  const result = spawnSync("pnpm", ["validate:data"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined || result.status === null) {
    process.stderr.write(
      `pnpm validate:data を実行できませんでした：${result.error?.message ?? "終了コードなし"}\n`,
    );
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(
      `祭りのデータの検証でエラーがありました（pnpm validate:data）。直してから進めてください。\n${result.stdout}${result.stderr}`,
    );
    return 2;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
