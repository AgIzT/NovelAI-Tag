/* 所长生日：每年 10 月 27 日起连续三天（本地日期，30 日零点自动撤下）——开场牌堆顶多一张生日牌，
   不带书名的直接进站落到所长 N5 常规法典，所长名下的书横幅挂生日签与彩旗，选择器法典卷头换成戴生日帽的所长头像。
   - 认人看 codexes.json 的 author，不写死书目：以后新开的所长书当天自动带上。
   - 地址带 ?birthday=1 时别的日子也按生日显示，给维护者预览用；模块加载时读一次，地址栏规范化去掉参数也不影响本页。
   - 生日牌的图先借 BIRTHDAY_CODEX_ID 那本书的封面；换专门的生日图时改那一处。 */

export const BIRTHDAY_PREVIEW_PARAM = 'birthday';
export const BIRTHDAY_AUTHOR = '戒红所';
export const BIRTHDAY_CODEX_ID = 'suozhang_nai5';   // 生日那几天的默认进站书，也是生日牌借封面的书
export const BIRTHDAY_LABEL = '10.27';

const BIRTHDAY = { month: 10, day: 27, days: 3 };   // days：从生日当天起连续显示几天（3 = 27、28、29 日）

const preview = (() => {
  try { return new URLSearchParams(location.search).get(BIRTHDAY_PREVIEW_PARAM) === '1'; } catch { return false; }
})();

export function isBirthday(date = new Date()) {
  if (preview) return true;
  const start = new Date(date.getFullYear(), BIRTHDAY.month - 1, BIRTHDAY.day);
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = Math.round((today - start) / 86400000);
  return offset >= 0 && offset < BIRTHDAY.days;
}

export function isBirthdayCodex(c) {
  return Boolean(c) && String(c.author || '').trim() === BIRTHDAY_AUTHOR && isBirthday();
}
