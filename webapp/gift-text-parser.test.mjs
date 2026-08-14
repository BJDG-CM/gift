import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCategory, parseGiftText } from './gift-text-parser.mjs';

const now = new Date(2026, 7, 12, 12, 0, 0);

test('extracts Korean gift card fields and prefers the expiry date', () => {
  const parsed = parseGiftText(`스타벅스\n아이스 카페 아메리카노 T\n발행일 2026.08.01\n유효기간 2026.12.31까지\n1234 5678 9012`, now);
  assert.equal(parsed.brand, '스타벅스');
  assert.equal(parsed.name, '아이스 카페 아메리카노 T');
  assert.equal(parsed.expiry, '2026-12-31');
  assert.equal(parsed.category, '카페');
});

test('understands Korean date notation and convenience-store category', () => {
  const parsed = parseGiftText(`GS25\n모바일 금액권 10,000원\n사용기한 2026년 10월 9일`, now);
  assert.equal(parsed.brand, 'GS25');
  assert.equal(parsed.expiry, '2026-10-09');
  assert.equal(parsed.category, '편의점');
});

test('infers the next year for a future month/day expiry', () => {
  const parsed = parseGiftText(`배스킨라빈스\n아이스크림 교환권\n유효기간 02/10`, now);
  assert.equal(parsed.expiry, '2027-02-10');
  assert.equal(parsed.category, '디저트');
});

test('category inference falls back cleanly', () => {
  assert.equal(inferCategory('알 수 없는 모바일 교환권'), '기타');
});

