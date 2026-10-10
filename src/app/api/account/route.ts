import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * ログイン中のユーザーのID（#3847）。iOSアプリが共有メニューから受け取った下書きを、
 * 共有した本人のアカウントにだけ渡すために使う。IDのほかは返さない。
 */
export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ id: currentUser.id }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * IssueDeckからの退会。削除するのはIssueDeckのアプリUser（とカスケードされる関連データ）だけ。
 *
 * Supabaseプロジェクトは他アプリと共有しているため、共有Authユーザー
 * （`auth.admin.deleteUser`）は削除しない。削除すると他アプリのログインまで失われる。
 * 再登録時は、残っているAuthユーザーでログインすればアプリUserが新規作成される。
 * 処理はDB削除1回だけなので、途中失敗で一部だけ完了する状態は生じない。
 */
export async function DELETE() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await db.user.delete({ where: { id: currentUser.id } });

  return NextResponse.json({ ok: true });
}
