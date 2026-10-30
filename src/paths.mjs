// 路径解析：让这个包不依赖任何固定安装位置。
//
// 规则（从高到低）：
//   1. env 覆盖（测试 / 多实例 / 换机时用）
//      QQ_MEMORY_CONFIG  → 配置文件路径
//      QQ_MEMORY_DIR     → 数据目录
//   2. 显式传参（宿主自己算好的路径）
//   3. config.memory.dir
//   4. 默认：<home>/.deepseek-memory/data
//
// 这个文件是「唯一」知道默认路径的地方，别在别处再写死。

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.deepseek-memory');
export const DEFAULT_DATA_DIR = path.join(HOME_DIR, 'data');
export const DEFAULT_CONFIG_FILE = path.join(HOME_DIR, 'config.json');

const clean = (v) => String(v ?? '').trim().replace(/^"+|"+$/g, '');

/** 数据目录：env > 显式 > 配置 > 默认。返回绝对路径（不保证存在）。 */
export function resolveDataDir({ explicit = '', configDir = '' } = {}) {
  const env = clean(process.env.QQ_MEMORY_DIR);
  const pick = env || clean(explicit) || clean(configDir) || DEFAULT_DATA_DIR;
  return path.resolve(pick.replace(/^~(?=[\\/]|$)/, os.homedir()));
}

/** 配置文件路径：env > 显式 > 默认。 */
export function resolveConfigFile(explicit = '') {
  const env = clean(process.env.QQ_MEMORY_CONFIG);
  const pick = env || clean(explicit) || DEFAULT_CONFIG_FILE;
  return path.resolve(pick);
}

/** 数据目录下的标准布局。 */
export function dataLayout(dir) {
  const root = path.resolve(dir);
  return {
    root,
    raw: path.join(root, 'raw'),
    hot: path.join(root, 'raw', 'hot'),
    archive: path.join(root, 'raw', 'archive'),
    digests: path.join(root, 'digests'),
    state: path.join(root, 'state'),
    logs: path.join(root, 'logs'),
    card: path.join(root, 'profile.md'),
    rules: path.join(root, 'rules.md'),
  };
}

/** 建目录（幂等），返回布局。 */
export function ensureDir(dir) {
  const lay = dataLayout(dir);
  for (const d of [lay.root, lay.raw, lay.hot, lay.archive, lay.digests, lay.state, lay.logs]) {
    mkdirSync(d, { recursive: true });
  }
  return lay;
}
