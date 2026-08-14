const BRAND_RULES = [
  ['스타벅스', /스타벅스|starbucks/i],
  ['투썸플레이스', /투썸|a\s*twosome/i],
  ['메가MGC커피', /메가\s*(?:mgc)?\s*커피|mega\s*coffee/i],
  ['컴포즈커피', /컴포즈\s*커피|compose\s*coffee/i],
  ['이디야커피', /이디야|ediya/i],
  ['빽다방', /빽다방|paik'?s\s*coffee/i],
  ['파리바게뜨', /파리바게뜨|paris\s*baguette/i],
  ['뚜레쥬르', /뚜레쥬르|tous\s*les\s*jours/i],
  ['배스킨라빈스', /배스킨라빈스|baskin\s*robbins/i],
  ['설빙', /설빙|sulbing/i],
  ['올리브영', /올리브영|olive\s*young/i],
  ['CU', /(?:^|\s)cu(?:\s|$)/i],
  ['GS25', /gs\s*25/i],
  ['세븐일레븐', /세븐일레븐|7\s*eleven/i],
  ['이마트24', /이마트\s*24|emart\s*24/i],
  ['교촌치킨', /교촌|kyochon/i],
  ['BHC', /(?:^|\s)bhc(?:\s|$)/i],
  ['BBQ', /(?:^|\s)bbq(?:\s|$)/i],
  ['네네치킨', /네네치킨/i],
  ['맘스터치', /맘스터치|mom'?s\s*touch/i],
  ['롯데리아', /롯데리아|lotteria/i],
  ['버거킹', /버거킹|burger\s*king/i],
  ['맥도날드', /맥도날드|mcdonald/i],
  ['카카오톡 선물하기', /카카오톡\s*선물하기/i]
];

const CATEGORY_RULES = [
  ['카페', /커피|카페|아메리카노|라떼|에스프레소|프라푸치노|스타벅스|투썸|메가\s*(?:mgc)?|컴포즈|이디야|빽다방/i],
  ['편의점', /편의점|\bcu\b|gs\s*25|세븐일레븐|이마트\s*24/i],
  ['치킨', /치킨|교촌|\bbhc\b|\bbbq\b|네네|굽네/i],
  ['디저트', /케이크|도넛|아이스크림|빙수|마카롱|베이커리|파리바게뜨|뚜레쥬르|배스킨|설빙/i],
  ['뷰티', /올리브영|화장품|뷰티|스킨|로션|향수|립스틱/i]
];

const DATE_KEYWORD = /유효\s*기간|사용\s*기한|교환\s*기간|이용\s*기간|만료|까지|expiry|valid/i;
const NOISE_LINE = /^(?:교환처|사용처|유효기간|사용기한|교환기간|쿠폰번호|바코드|주문번호|발행일|주의사항|이용안내|문의|고객센터)\s*[:：]?\s*$/i;
const PRODUCT_HINT = /아메리카노|라떼|커피|음료|케이크|도넛|아이스크림|빙수|치킨|버거|세트|상품권|금액권|쿠폰|교환권|기프티콘|향수|로션|크림|립|메뉴/i;

function pad(value) {
  return String(value).padStart(2, '0');
}

function validDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function extractDates(line, now) {
  const found = [];
  const patterns = [
    /\b(20\d{2}|\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})\b/g,
    /\b(20\d{2}|\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g
  ];

  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      let year = Number(match[1]);
      if (year < 100) year += 2000;
      const value = validDate(year, Number(match[2]), Number(match[3]));
      if (value) found.push(value);
    }
  }

  if (!found.length && DATE_KEYWORD.test(line)) {
    const match = line.match(/\b(\d{1,2})\s*[.\/-]\s*(\d{1,2})\b/);
    if (match) {
      let year = now.getFullYear();
      const month = Number(match[1]);
      const day = Number(match[2]);
      let value = validDate(year, month, day);
      if (value && new Date(`${value}T23:59:59`) < now) value = validDate(year + 1, month, day);
      if (value) found.push(value);
    }
  }
  return [...new Set(found)];
}

function dateOrdinal(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59).getTime();
}

function pickExpiry(lines, now) {
  const candidates = [];
  lines.forEach((line, index) => {
    extractDates(line, now).forEach(value => {
      const future = dateOrdinal(value) >= now.getTime();
      candidates.push({ value, score: (DATE_KEYWORD.test(line) ? 10 : 0) + (future ? 4 : -5) - index * 0.001 });
    });
  });
  candidates.sort((a, b) => b.score - a.score || dateOrdinal(a.value) - dateOrdinal(b.value));
  return candidates[0]?.value || '';
}

function cleanProductLine(line) {
  return line
    .replace(/^[\s·•*\-–—]+|[\s·•*\-–—]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function productScore(line, brand) {
  if (line.length < 2 || line.length > 60) return -100;
  if (NOISE_LINE.test(line) || DATE_KEYWORD.test(line)) return -100;
  if (/https?:|www\.|₩|원\s*$|\d{8,}|^[\d\s\-:.\/]+$|copyright|고객센터|문의/i.test(line)) return -100;
  if (brand && line.replace(/\s/g, '').toLowerCase() === brand.replace(/\s/g, '').toLowerCase()) return -50;
  let score = 0;
  if (PRODUCT_HINT.test(line)) score += 8;
  if (/[가-힣]/.test(line)) score += 3;
  if (/\d|[A-Za-z]/.test(line)) score += 1;
  if (line.length >= 4 && line.length <= 32) score += 2;
  if (/선물|축하|감사|gift/i.test(line)) score -= 4;
  return score;
}

export function inferCategory(text) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return '기타';
}

export function parseGiftText(rawText, now = new Date()) {
  const text = String(rawText || '').replace(/\r/g, '\n');
  const lines = text.split(/\n+/).map(cleanProductLine).filter(Boolean);
  const brand = BRAND_RULES.find(([, pattern]) => pattern.test(text))?.[0] || '';
  const expiry = pickExpiry(lines, now);
  const ranked = lines
    .map((line, index) => ({ line, index, score: productScore(line, brand) }))
    .filter(candidate => candidate.score > -50)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const name = ranked[0]?.line || '';
  const category = inferCategory(`${brand}\n${name}\n${text}`);
  const fieldsFound = [name, brand, expiry].filter(Boolean).length;

  return {
    name,
    brand,
    expiry,
    category,
    confidence: fieldsFound >= 3 ? 'high' : fieldsFound >= 1 ? 'medium' : 'low'
  };
}

