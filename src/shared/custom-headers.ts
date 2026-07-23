import { z } from 'zod';

const RFC_TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const UNRELIABLE_VALUE_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

export const customHeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(RFC_TCHAR, 'custom header 名称不合法');

export const customHeaderValueSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isReliableHeaderValue, 'custom header 值包含不安全的控制字符')
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(4096));

export const customHeadersSchema = z.record(customHeaderNameSchema, customHeaderValueSchema);

export function validateCustomHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  return headers === undefined ? undefined : customHeadersSchema.parse(headers);
}

function isReliableHeaderValue(value: string): boolean {
  if (UNRELIABLE_VALUE_CODE_POINT.test(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      return false;
    }
  }
  return true;
}
