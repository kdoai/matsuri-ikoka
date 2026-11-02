// PostToolUse のフック。`gh repo create` を実行したあとに、
// リポジトリの設定（setup-github-repo スキル）を入れるよう Claude に伝える。
// 設定は外に影響するので、ここでは実行せず知らせるだけにする。

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
}

const { tool_input, tool_response } = JSON.parse(raw);
const command = tool_input?.command ?? "";
// 作れたときは、gh がリポジトリの URL を出す
const created = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(JSON.stringify(tool_response ?? ""));

if (created && /(^|[;&|(]\s*)gh\s+repo\s+create\b/.test(command)) {
  const additionalContext =
    "GitHub にリポジトリを作りました。main を push したあと、setup-github-repo スキルで" +
    "公開の設定（秘密情報の検出と push の保護、脆弱性の非公開の報告、main の保護、ラベル）を入れてください。" +
    "入れる前に、ユーザーの了承を得てください。";
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }),
  );
}
