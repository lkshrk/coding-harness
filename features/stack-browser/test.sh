#!/usr/bin/env bash
set -euo pipefail

playwright --version
ls "${PLAYWRIGHT_BROWSERS_PATH:?}" | grep -q '^chromium_headless_shell-'
if ls "$PLAYWRIGHT_BROWSERS_PATH" | grep -qE '^chromium-[0-9]+$'; then
  echo "headed Chromium installed; only the headless shell is expected" >&2
  exit 1
fi

NODE_PATH=/opt/nightshift/stack-browser/node_modules node - <<'JS'
const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } })
  await page.setContent('<div id="box" style="width:120px;height:40px">ok</div>')
  const box = await page.locator('#box').boundingBox()
  const png = await page.screenshot()
  await browser.close()
  if (!box || box.width !== 120 || png.length === 0) throw new Error(`unexpected render ${JSON.stringify(box)}`)
  console.log(`headless shell rendered ${box.width}x${box.height}, screenshot ${png.length} bytes`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
JS
