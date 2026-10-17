import { expect, it, vi } from 'vitest';
import { clearReference, settingNumber } from '../src/api/http';

it('セッション切れで参照表を消した直後は、設定値の欠落警告を出さない', () => {
  clearReference();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(settingNumber('attachment.max_count_diary', 3)).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});
