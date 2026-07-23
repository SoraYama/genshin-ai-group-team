import { describe, expect, it } from 'vitest';
import {
  destructiveErrorRecovery,
  localizeError
} from '../../../src/renderer/i18n/error-localization.js';

type Translator = Parameters<typeof localizeError>[2];

const translations = {
  'common.error.unknown': { 'zh-CN': '未知错误', 'en-US': 'Unknown error' },
  'common.error.confirmationExpired': {
    'zh-CN': '确认已过期，未执行删除。请重新打开确认框后再试。',
    'en-US': 'The confirmation expired. Nothing was deleted. Open the confirmation again and retry.'
  },
  'common.error.selectionChanged': {
    'zh-CN': '待删除内容在确认后发生变化，未执行删除。请刷新后重新确认。',
    'en-US': 'The selected data changed after confirmation. Nothing was deleted. Refresh and confirm again.'
  },
  'common.error.fileInspection': {
    'zh-CN': '部分本地挑战资料无法完整读取。为避免误删，暂时不能清理；请重新检查。',
    'en-US': 'Some local challenge data could not be fully read. Cleanup is paused to avoid data loss. Check again.'
  }
} as const;

function translator(locale: 'zh-CN' | 'en-US'): Translator {
  return ((key: keyof typeof translations) =>
    translations[key]?.[locale] ?? String(key)) as Translator;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('localizeError', () => {
  it('provides explicit retry, reconfirm, and no-action recovery copy', () => {
    expect(destructiveErrorRecovery('IPC_CONFIRMATION_EXPIRED', 'zh-CN')).toEqual({
      kind: 'reconfirm',
      label: '重新检查并确认'
    });
    expect(destructiveErrorRecovery('IPC_FILE_INSPECTION_FAILED', 'en-US')).toEqual({
      kind: 'retry',
      label: 'Check again'
    });
    expect(destructiveErrorRecovery('IPC_NOTHING_TO_CLEAR', 'zh-CN')).toEqual({
      kind: 'none',
      label: ''
    });
  });

  it('prioritizes stable confirmation and inspection codes in both languages', () => {
    expect(
      localizeError(
        codedError('IPC_CONFIRMATION_EXPIRED', 'Clear confirmation expired; confirm again'),
        'zh-CN',
        translator('zh-CN'),
        'common.error.unknown'
      )
    ).toBe(translations['common.error.confirmationExpired']['zh-CN']);
    expect(
      localizeError(
        codedError('IPC_SELECTION_CHANGED', 'Data selection changed'),
        'en-US',
        translator('en-US'),
        'common.error.unknown'
      )
    ).toBe(translations['common.error.selectionChanged']['en-US']);
    expect(
      localizeError(
        codedError('IPC_FILE_INSPECTION_FAILED', 'Scenario files could not be fully inspected'),
        'zh-CN',
        translator('zh-CN'),
        'common.error.unknown'
      )
    ).toBe(translations['common.error.fileInspection']['zh-CN']);
  });

  it('never exposes an unrecognized Main-process English message in Chinese', () => {
    expect(
      localizeError(
        codedError('UNRECOGNIZED_MAIN_ERROR', 'History selection fingerprint changed'),
        'zh-CN',
        translator('zh-CN'),
        'common.error.unknown'
      )
    ).toBe('未知错误');
  });

  it('does not expose arbitrary Main-process messages in English either', () => {
    expect(
      localizeError(
        codedError('UNRECOGNIZED_MAIN_ERROR', 'Secret internal file path failed'),
        'en-US',
        translator('en-US'),
        'common.error.unknown'
      )
    ).toBe('Unknown error');
  });
});
