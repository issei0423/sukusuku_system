/*
 * 手元のサーバでデモをするとき、iPad・iPhone で開く URL を PC の IP から決める（scripts/demoTargets.mjs）
 * デモ手順書.md「2」の「開くところ」：iPad は PC のホットスポット（192.168.137.1）、iPhone は USB テザリング（172.20.10.x）
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error 型の無い .mjs（scripts は tsconfig の外）
import { demoTargets } from '../scripts/demoTargets.mjs';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });

describe('デモで開く URL', () => {
  it('ホットスポットの IP を保育士（職員用トップ）、USB テザリングの IP を保護者（保護者用トップ）にする', () => {
    const t = demoTargets({
      'Wi-Fi': [v4('169.254.10.1')],
      'ローカル エリア接続* 10': [v4('192.168.137.1')],
      'イーサネット 2': [v4('172.20.10.4'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      'Loopback': [v4('127.0.0.1', true)],
    }, 8080);
    expect(t.staff).toEqual({ ip: '192.168.137.1', url: 'http://192.168.137.1:8080/staff-top' });
    expect(t.guardian).toEqual({ ip: '172.20.10.4', url: 'http://172.20.10.4:8080/' });
    expect(t.others).toEqual([]);
  });

  it('つないでいないときは null。学校の Wi-Fi などは「そのほか」に両方の URL を出す（169.254 と内側は出さない）', () => {
    const t = demoTargets({ 'Wi-Fi': [v4('10.108.1.184')], 'イーサネット': [v4('169.254.50.123')], 'lo': [v4('127.0.0.1', true)] }, 8091);
    expect(t.staff).toBeNull();
    expect(t.guardian).toBeNull();
    expect(t.others).toEqual([{ name: 'Wi-Fi', ip: '10.108.1.184', staffUrl: 'http://10.108.1.184:8091/staff-top', guardianUrl: 'http://10.108.1.184:8091/' }]);
  });

  it('Node の版で family が数の 4 でも IPv4 として扱う', () => {
    const t = demoTargets({ 'イーサネット 2': [{ address: '172.20.10.2', family: 4, internal: false }] }, 8080);
    expect(t.guardian?.url).toBe('http://172.20.10.2:8080/');
  });
});
