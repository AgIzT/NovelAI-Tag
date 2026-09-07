"""Open or start this worktree's local preview using the workspace launch registry."""
import json
import threading
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from preview_server import Handler, Server


def main():
    root = Path(__file__).resolve().parent.parent
    registry = root.parent / '.claude' / 'launch.json'
    configurations = json.loads(registry.read_text(encoding='utf-8-sig'))['configurations']
    configuration = next(item for item in configurations if item['name'] == 'fadian-blocking')
    port = int(configuration['port'])
    url = f'http://127.0.0.1:{port}/?c=suozhang'
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            existing = response.read().decode('utf-8')
        if 'id="contentBlocking"' not in existing:
            raise RuntimeError('The preview port is used by another service. Check .claude/launch.json.')
    except (urllib.error.URLError, TimeoutError):
        with Server(('127.0.0.1', port), Handler) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            webbrowser.open(url)
            print(f'Preview: {url}\nKeep this window open. Press Ctrl+C to stop.')
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                server.shutdown()
    else:
        webbrowser.open(url)


if __name__ == '__main__':
    main()
