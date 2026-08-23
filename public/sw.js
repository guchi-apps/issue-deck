/*
 * IssueDeckのService Worker（#838）。
 *
 * **やることはPush通知の受け取りと、タップしたときの遷移だけ。** `fetch`は扱わない——
 * ここでキャッシュを持つと、デプロイのたびに古い画面が残る事故と、認証済みの応答が
 * 別のセッションへ漏れる事故の両方を抱えることになる。PWAとしての起動は
 * `app/manifest.ts`（`start_url: /dashboard`）だけで成立している。
 *
 * このファイルは`src/proxy.ts`のmatcherから除外してある。除外しないと、Supabaseの
 * セッションが切れた状態での更新チェックに`/login`のHTMLが返り、MIMEタイプ不一致で
 * Service Workerの更新が落ちる。
 */

// 更新をすぐ効かせる。中身が小さく、古い版が動き続ける理由が無い
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * **届いたpushには必ず通知を出す**（#2196）。以前は表示中のウィンドウがあるときだけ
 * `showNotification`を呼ばずに終えていた（画面内のトーストと二重にしないため）が、
 * 購読は`userVisibleOnly: true`で作っており、Web Push仕様では出すことが前提になっている。
 * 出さないpushが続くとiOSは購読そのものを失効させ、**アプリを閉じているときにも
 * 届かなくなる**。Chromeも代わりに「バックグラウンドで更新されました」を出す。
 *
 * 二重に出さないための調整は画面側へ移した。この端末が通知を受け取れているあいだは
 * 画面内のトーストを出さない（`use-push-delivery.ts`）。**出口はOSの通知1つ**になる。
 *
 * ついでに直る穴が1つある。`visibilityState`はウィンドウが他のアプリの背後にあるだけでも
 * `visible`のままなので、以前の判定はPCでアプリを開きっぱなしにしている間の通知を
 * まるごと握りつぶしていた。
 */
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      /** @type {{title?: string, body?: string, url?: string, tag?: string}} */
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        // 中身を読めない通知は、無言で捨てずに既定の文面で出す
        payload = {};
      }

      const title = payload.title || "確認待ちのIssueがあります";
      await self.registration.showNotification(title, {
        body: payload.body || "",
        // ホーム画面のアイコンと同じもの。通知センターでどのアプリか分かるように
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        // 同じIssueの通知が続けて届いたら、古い方を置き換えて1件にまとめる
        tag: payload.tag || "issue-deck",
        renotify: Boolean(payload.tag),
        data: { url: payload.url || "/dashboard" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/dashboard";
  const targetUrl = new URL(target, self.location.origin);

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // すでに開いているウィンドウがあれば、そこを前面に出して同じIssueへ動かす。
      // 新しく開くと、PWAとブラウザタブで同じアプリが二重に立つ
      for (const client of clientList) {
        if (new URL(client.url).origin !== targetUrl.origin) continue;
        if ("navigate" in client) {
          const navigated = await client.navigate(targetUrl.href);
          if (navigated) {
            await navigated.focus();
            return;
          }
        }
        await client.focus();
        return;
      }
      await self.clients.openWindow(targetUrl.href);
    })(),
  );
});
