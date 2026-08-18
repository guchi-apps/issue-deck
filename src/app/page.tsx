import { redirect } from "next/navigation";

// ログイン済みならmiddlewareを素通りしてここへ来る。以前は/loginへ送っていたが、
// middlewareが/login→/dashboardへ折り返すため、ホーム画面から起動するたびに
// 認証の確認を含む往復を1回余計にしていた（#1978）。未ログインの場合はそもそも
// middlewareが/loginへ送るので、ここが動くのはログイン済みのときだけ。
export default function Home() {
  redirect("/dashboard");
}
