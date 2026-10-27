#!/usr/bin/env bash
# Downloads the arXiv papers used by the matcher test into tests/papers/.
#   ResNet (1512.03385)  two-column CVPR layout, equations, ligatures
#   BERT   (1810.04805)  two-column ACL layout, heavy hyphenation, figures
#   GPT-3  (2005.14165)  75 pages, tables, table of contents
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/tests/papers"
mkdir -p "$DIR"
for id in 1512.03385 1810.04805 2005.14165; do
  [ -s "$DIR/$id.pdf" ] || curl -fsSL -A "Mozilla/5.0" -o "$DIR/$id.pdf" "https://arxiv.org/pdf/$id"
done
echo "Papers in $DIR"
