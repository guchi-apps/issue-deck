#!/usr/bin/env python3
"""Codexのapp-serverへJSON-RPCを1本送る（#3357）。

使い方: codex-app-server-rpc.py <method> <paramsのJSON>

**走っているデーモンがあれば、その制御ソケットへ送る。** ChatGPTアプリのリモート制御で開いた
スレッドはデーモンが読み込んで書き手（writer）になっており、stdioで別に起こした
`codex app-server`から`thread/archive`を打つと`thread … already has an active writer`で
拒否される（実機・codex-cli 0.152.1）。デーモンへ送れば、読み込み中のスレッドも閉じたうえで
アーカイブされる。

- 制御ソケットは`$CODEX_HOME/app-server-control/app-server-control.sock`で、**話し方は
  WebSocket**（テキストフレームにJSON-RPCを1本ずつ）。`codex app-server proxy`はNDJSON・
  `Content-Length`のどちらでも応答しなかったため使わない（`lib/codex-thread-name.sh`）
- ソケットが無い・繋がらないときは、stdioの`codex app-server`を1回起こして送る
  （デーモンが上がっていなければ、書き手を握っている者もいない）

出力と終了コード（**呼び出し元の分岐はこれだけを見る**）:
  0  成功。標準出力へ`ok`
  3  対象のスレッドの転記が無い（`no rollout found`）。アーカイブ済み・転記の無いスレッド
  4  別のプロセスが書き手を握っている（`active writer`）。まだ動いている
  2  それ以外の失敗。標準出力へ理由を1行

標準ライブラリだけで書く（サブPCへ依存を足さないため）。
"""

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time

TIMEOUT_SECONDS = float(os.environ.get("ISSUE_DECK_CODEX_RPC_TIMEOUT_SECONDS", "20"))


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")


def socket_path():
    return os.environ.get("ISSUE_DECK_CODEX_APP_SERVER_SOCKET") or os.path.join(
        codex_home(), "app-server-control", "app-server-control.sock"
    )


def codex_command():
    """standalone installがあればPATHより優先する（`lib/agent-cli.sh`の`agent_cli_codex_command`と同じ）。"""
    if os.environ.get("ISSUE_DECK_CODEX_COMMAND"):
        return os.environ["ISSUE_DECK_CODEX_COMMAND"]
    standalone = os.path.join(codex_home(), "packages", "standalone", "current", "codex")
    return standalone if os.access(standalone, os.X_OK) else "codex"


INITIALIZE = {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "issue-deck", "version": "1"}}}
INITIALIZED = {"method": "initialized", "params": {}}
REQUEST_ID = 2


class WebSocketChannel:
    """Unixソケット上のWebSocket。クライアントのフレームはマスクする（RFC 6455）。"""

    def __init__(self, path, deadline):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(max(0.1, deadline - time.time()))
        self.sock.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise OSError("handshake closed")
            buf += chunk
        head, self.rest = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError("handshake refused")

    def send(self, obj):
        data = json.dumps(obj).encode()
        n = len(data)
        if n < 126:
            header = bytes([0x81, 0x80 | n])
        elif n < 65536:
            header = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
        else:
            header = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _exact(self, n):
        while len(self.rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError("connection closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def recv(self):
        """テキストフレームを1つ返す。それ以外（ping等）は読み飛ばす。"""
        while True:
            b1, b2 = self._exact(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exact(8))[0]
            if b2 & 0x80:
                mask = self._exact(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._exact(n)))
            else:
                payload = self._exact(n)
            opcode = b1 & 0x0F
            if opcode == 0x8:
                raise OSError("connection closed")
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class StdioChannel:
    """stdioの`codex app-server`。**応答を読むまでstdinを閉じない**（閉じると処理せずに終わる）。"""

    def __init__(self):
        self.proc = subprocess.Popen(
            [codex_command(), "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def recv(self):
        line = self.proc.stdout.readline()
        if not line:
            raise OSError("codex app-server exited")
        return line

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def exchange(channel, method, params, deadline):
    channel.send(INITIALIZE)
    channel.send(INITIALIZED)
    channel.send({"id": REQUEST_ID, "method": method, "params": params})
    while time.time() < deadline:
        raw = channel.recv()
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if message.get("id") == REQUEST_ID:
            return message
    raise TimeoutError("no response")


def classify(message):
    if "result" in message:
        print("ok")
        return 0
    error = (message.get("error") or {}).get("message") or json.dumps(message)[:200]
    if "no rollout found" in error:
        print(error)
        return 3
    if "active writer" in error:
        print(error)
        return 4
    print(error.replace("\n", " ")[:200])
    return 2


def main(argv):
    if len(argv) != 3:
        print("usage: codex-app-server-rpc.py <method> <params-json>")
        return 2
    method = argv[1]
    try:
        params = json.loads(argv[2])
    except ValueError:
        print("params is not JSON")
        return 2

    deadline = time.time() + TIMEOUT_SECONDS
    path = socket_path()
    if os.path.exists(path):
        channel = None
        try:
            channel = WebSocketChannel(path, deadline)
            return classify(exchange(channel, method, params, deadline))
        except (OSError, TimeoutError, ValueError):
            # 古いソケットが残っているだけのことがある。stdioへ落とす
            pass
        finally:
            if channel is not None:
                channel.close()

    try:
        channel = StdioChannel()
    except OSError as error:
        print(f"codex app-server を起動できませんでした: {error}")
        return 2
    try:
        return classify(exchange(channel, method, params, deadline))
    except (OSError, TimeoutError) as error:
        print(f"codex app-server から応答がありませんでした: {error}")
        return 2
    finally:
        channel.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
