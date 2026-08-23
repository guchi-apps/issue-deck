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

/** 表示中（画面が見えている）のウィンドウがあるか */
async function hasVisibleClient() {
  const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return clientList.some((client) => client.visibilityState === "visible");
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      /** @type {{title?: string, body?: string, url?: string, tag?: string, force?: boolean}} */
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        // 中身を読めない通知は、無言で捨てずに既定の文面で出す
        payload = {};
      }

      // **アプリを開いているあいだは出さない。** 同じ知らせを画面内のトースト
      // （check-user-toast-viewport.tsx）が出しており、OS側にも重ねると
      // どちらを押せばよいのか分からなくなる。
      //
      // **例外は`force`が付いた通知だけ**（#2195）。テスト通知は設定画面のボタンからしか
      // 送れず、押した時点でその画面が必ず表示中になるため、この判定に当たると
      // 「届くかどうかを確かめる通知」が毎回握りつぶされる
      if (!payload.force && (await hasVisibleClient())) return;

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
