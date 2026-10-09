import { describe, it, expect, vi } from 'vitest';
import { listOpenPullRequests } from './lib/ios-precheck-pr-list.mjs';

const repo = 'guchi-apps/yoteiflow';
const fullPage = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
describe('旧版ghでのiOS検証PR一覧取得', () => {
  it('空の一覧を返す', () => {
    const gh = vi.fn().mockReturnValue([]);
    expect(listOpenPullRequests(gh, repo)).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it('100件を超えるPRをページ指定だけで取得する', () => {
    const gh = vi.fn().mockReturnValueOnce(fullPage).mockReturnValueOnce([{ number: 101 }]);
    expect(listOpenPullRequests(gh, repo)).toHaveLength(101);
    expect(gh.mock.calls).toEqual([1, 2].map(page => [`repos/${repo}/pulls?state=open&base=develop&per_page=100&page=${page}`]));
  });
  it('ちょうど100件なら空の次ページで終了する', () => {
    const gh = vi.fn().mockReturnValueOnce(fullPage).mockReturnValueOnce([]);
    expect(listOpenPullRequests(gh, repo)).toEqual(fullPage);
    expect(gh).toHaveBeenCalledTimes(2);
  });
  it('巡回中の変動による重複を除く', () => {
    const gh = vi.fn().mockReturnValueOnce(fullPage).mockReturnValueOnce([{ number: 100 }, { number: 101 }]);
    expect(listOpenPullRequests(gh, repo)).toHaveLength(101);
  });
  it('途中の失敗では不完全な一覧を返さず、秘密のエラー詳細も出さない', () => {
    const gh = vi.fn().mockReturnValueOnce(fullPage).mockImplementationOnce(() => { throw new Error('private-value'); });
    expect(() => listOpenPullRequests(gh, repo)).toThrow('page=2');
  });
  it('不正な応答を成功扱いしない', () => {
    expect(() => listOpenPullRequests(() => ({ message: 'error' }), repo)).toThrow('配列');
  });
});
