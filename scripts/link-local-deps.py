"""Link installed checkout dependencies without changing the upstream checkout."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parent.parent
configured = os.environ.get("DSH_CHECKOUT")
if not configured:
    raise SystemExit("请设置 DSH_CHECKOUT，指向已完成安装与构建的 DeepSeek Harness 源码目录。")
checkout = Path(configured).expanduser().resolve()
modules = root / "node_modules"
if modules.is_symlink():
    modules.unlink()
modules.mkdir(exist_ok=True)


def link(name, target):
    path = modules / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        if path.resolve() == target.resolve():
            return
        path.unlink()
    elif path.exists():
        raise RuntimeError(f"Refuse to overwrite {path}")
    path.symlink_to(target, target_is_directory=True)


for base in [checkout / "packages", checkout / "vendor"]:
    patterns = ["*/*/package.json"] if base.name == "packages" else ["*/package.json"]
    for pattern in patterns:
        for manifest in base.glob(pattern):
            name = json.loads(manifest.read_text()).get("name", "")
            if name.startswith("@deepseek-ai/"):
                link(name, manifest.parent)
for name in ["typescript", "js-yaml", "@types/node", "@types/js-yaml"]:
    target = checkout / "node_modules" / name
    if target.exists():
        link(name, target.resolve())
print("Local dependency links prepared; upstream unchanged")
