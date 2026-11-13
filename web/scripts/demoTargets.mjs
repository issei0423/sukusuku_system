/*
 * 演習用：手元のサーバでデモをするとき、iPad・iPhone で開く URL を、PC の IP から決める。
 * demo.mjs が使う。デモ手順書.md「2」の「開くところ」と同じ決め方。
 *
 * - 保育士（iPad）：PC のモバイル ホットスポットの側。Windows の既定で 192.168.137.1
 * - 保護者（iPhone）：iPhone の USB テザリングの側。PC には 172.20.10.x が付く
 * どちらも見つからないときは、ほかの IPv4（学校の Wi-Fi など）を「そのほか」として返す。
 */

/** 192.168.137.x（Windows のホットスポット）か */
const isHotspot = (ip) => ip.startsWith('192.168.137.');
/** 172.20.10.x（iPhone のインターネット共有）か */
const isIPhoneTether = (ip) => ip.startsWith('172.20.10.');

/**
 * os.networkInterfaces() の形から、開く URL を決める。
 * @param {Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>} interfaces
 * @param {number} port
 */
export function demoTargets(interfaces, port) {
  const ips = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      // Node は family を 'IPv4' か 4 で返す（版で違う）
      if (a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
      if (a.address.startsWith('169.254.')) continue; // つながっていない口の仮の番地
      ips.push({ name, ip: a.address });
    }
  }
  const hotspot = ips.find((x) => isHotspot(x.ip));
  const tether = ips.find((x) => isIPhoneTether(x.ip));
  const url = (ip, path) => `http://${ip}:${port}${path}`;
  return {
    staff: hotspot ? { ip: hotspot.ip, url: url(hotspot.ip, '/staff-top') } : null,
    guardian: tether ? { ip: tether.ip, url: url(tether.ip, '/') } : null,
    others: ips
      .filter((x) => !isHotspot(x.ip) && !isIPhoneTether(x.ip))
      .map((x) => ({ name: x.name, ip: x.ip, staffUrl: url(x.ip, '/staff-top'), guardianUrl: url(x.ip, '/') })),
  };
}
