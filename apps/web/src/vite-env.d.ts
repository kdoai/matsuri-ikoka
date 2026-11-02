/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** true なら、本番のビルドにも画面だけのモックを含める */
  readonly VITE_ENABLE_MOCK?: string;
  /** 既定の通信先（mock または server） */
  readonly VITE_TRANSPORT?: string;
}
