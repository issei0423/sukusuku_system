/** 'YYYY-MM-DD' を「10月15日」の形にする（成長の記録画面。図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6)） */
export function monthDay(iso: string): string {
  return `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;
}
