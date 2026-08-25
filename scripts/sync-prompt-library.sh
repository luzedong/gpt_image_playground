#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
public_dir="$project_root/public"
target_dir="$public_dir/prompt-library"
repo_url=${PROMPT_LIBRARY_REPO_URL:-https://github.com/freestylefly/awesome-gpt-image-2.git}
repo_ref=${PROMPT_LIBRARY_REF:-main}
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/gpt-image-prompt-library.XXXXXX")
next_dir=$(mktemp -d "$public_dir/.prompt-library-next.XXXXXX")
backup_dir=$(mktemp -d "$public_dir/.prompt-library-backup.XXXXXX")
rmdir "$backup_dir"

cleanup() {
  rm -rf "$temp_dir" "$next_dir"
  if [ -d "$backup_dir" ]; then
    if [ ! -e "$target_dir" ]; then
      mv "$backup_dir" "$target_dir"
    else
      rm -rf "$backup_dir"
    fi
  fi
}

trap cleanup EXIT INT TERM

echo "正在拉取 Prompt 素材库：$repo_url ($repo_ref)"
git clone --depth 1 --no-tags --single-branch --branch "$repo_ref" "$repo_url" "$temp_dir/upstream"
commit=$(git -C "$temp_dir/upstream" rev-parse HEAD)

manifest="$temp_dir/upstream/data/cases.json"
images_dir="$temp_dir/upstream/data/images"

node - "$manifest" "$images_dir" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const manifestPath = process.argv[2]
const imagesDir = process.argv[3]
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const cases = Array.isArray(manifest.cases) ? manifest.cases : []
const images = fs.readdirSync(imagesDir).filter((file) => /^case\d+\.(?:jpe?g|png|webp)$/i.test(file))

if (!cases.length) throw new Error('上游 cases.json 没有可用案例')
if (!images.length) throw new Error('上游 data/images 没有可用案例图')

const imageNames = new Set(images)
const missing = cases
  .map((item) => path.basename(typeof item.image === 'string' ? item.image : ''))
  .filter((file) => !imageNames.has(file))

if (missing.length) throw new Error(`有 ${missing.length} 个案例缺少图片：${missing.slice(0, 5).join(', ')}`)
console.log(`已校验 ${cases.length} 个案例、${images.length} 张图片`)
NODE

cp "$manifest" "$next_dir/cases.json"
mkdir "$next_dir/images"
for image in "$images_dir"/case*.jpg "$images_dir"/case*.jpeg "$images_dir"/case*.png "$images_dir"/case*.webp; do
  if [ -f "$image" ]; then
    cp "$image" "$next_dir/images/"
  fi
done

if [ -f "$temp_dir/upstream/LICENSE" ]; then
  cp "$temp_dir/upstream/LICENSE" "$next_dir/LICENSE"
fi
if [ -f "$temp_dir/upstream/README.md" ]; then
  cp "$temp_dir/upstream/README.md" "$next_dir/UPSTREAM-README.md"
fi
if [ -f "$temp_dir/upstream/docs/disclaimer.md" ]; then
  cp "$temp_dir/upstream/docs/disclaimer.md" "$next_dir/disclaimer.md"
fi

node - "$next_dir/source.json" "$repo_url" "$repo_ref" "$commit" "$next_dir/LICENSE" "$next_dir/UPSTREAM-README.md" "$next_dir/disclaimer.md" <<'NODE'
const fs = require('node:fs')

const outputPath = process.argv[2]
const repository = process.argv[3]
const ref = process.argv[4]
const commit = process.argv[5]
const documents = process.argv.slice(6)
fs.writeFileSync(outputPath, `${JSON.stringify({ repository, ref, commit }, null, 2)}\n`)
for (const document of documents) {
  if (!fs.existsSync(document)) continue
  const content = fs.readFileSync(document, 'utf8')
  fs.writeFileSync(document, content.replace(/\r\n?/g, '\n'))
}
NODE

if [ -e "$target_dir" ]; then
  mv "$target_dir" "$backup_dir"
fi
mv "$next_dir" "$target_dir"
rm -rf "$backup_dir"

size=$(du -sh "$target_dir" | awk '{print $1}')
echo "Prompt 素材库已更新：$target_dir ($size)"
