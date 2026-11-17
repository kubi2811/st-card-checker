#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Chưa cài Node.js. Hãy tải bản LTS tại https://nodejs.org rồi chạy lại."
  open https://nodejs.org
  read -n 1 -s -r -p "Nhấn phím bất kỳ để đóng…"
  exit 1
fi
node launcher.js
