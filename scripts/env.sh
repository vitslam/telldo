# Source this file on the company Linux development machine.
TELLDO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$TELLDO_ROOT/.tools/bin:$TELLDO_ROOT/.tools/node-v22.21.1-linux-x64/bin:$HOME/.local/bin:$PATH"
if [ -n "${TELLDO_PROXY_URL:-}" ]; then
  export https_proxy="$TELLDO_PROXY_URL" http_proxy="$TELLDO_PROXY_URL"
  export no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1,github.com,.githubusercontent.com"
fi
