# 第三者の著作物の表示

`web/` の画面の見た目は、デジタル庁デザインシステム（DADS）の決まりに沿って作っている。
DADS が公開しているもののうち、**値や形を写して `web/src/styles/` に入れたもの**を次に挙げ、それぞれのライセンスの表示を載せる。

npm のパッケージとしては入れていない（`package.json` の依存には無い）。必要な値だけを CSS に写している。

| 写したもの | 写した先 | 出どころ | ライセンス |
| :-- | :-- | :-- | :-- |
| 色の値（`--dads-*`）、影の値（`--elevation-2`・`--elevation-3`） | `src/styles/tokens.css` | `@digital-go-jp/design-tokens` v2.0.1 の `dist/tokens.css`（<https://github.com/digital-go-jp/design-tokens>） | MIT License（下の 1） |
| セレクトボックスの下向きの印（SVG の形）、フォーカスの印の太さと色の組み合わせ | `src/styles/tokens.css` | DADS の HTML 実装例 `design-system-example-components-html`（<https://github.com/digital-go-jp/design-system-example-components-html>、2026-10-17 に `main` の `af8b665` を参照） | MIT License（下の 2） |

次のものは写していない。参照しただけである。

- DADS の解説サイト（<https://design.digital.go.jp/dads/>）の文章・図。部品の使い方の決まりを読んで、CSS を自分で書いた。
- DADS の Figma のデザインデータ（CC BY 4.0）と、その中のアイコン（Material Symbols、Apache License 2.0）。使っていない。
  利用上の注意：<https://design.digital.go.jp/dads/introduction/notices/>
- 書体の Noto Sans JP。`font-family` に名前を書いているだけで、フォントのファイルは配っていない。
  端末に入っていればそれで表示し、無ければヒラギノ角ゴシックなど端末の書体で表示する。
  将来フォントのファイルを同梱するときは、その書体のライセンス（Noto Sans JP は SIL Open Font License 1.1）の表示をここに足すこと。

---

## 1. @digital-go-jp/design-tokens

```
MIT License

Copyright (c) 2023 デジタル庁

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. design-system-example-components-html

```
MIT License

Copyright (c) 2025 デジタル庁

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
