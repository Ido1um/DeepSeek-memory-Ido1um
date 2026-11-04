// 修时间锚：早期 episode 抽取的 supersede 事件没带时间字段，新值会顶着旧值的过期日期。
// 这里按「引文在窗口账本里的那一条」重新推导 saidAt / validUntil，只对改得动的条目追加 update。
import * as lt from '../src/longterm.mjs';
import { readEpisodes } from '../src/episode.mjs';
import { turnAtFor } from '../src/extract-episode.mjs';
import { parseTime } from '../src/timeparse.mjs';
import { readTurns } from '../src/window.mjs';

const dir = process.env.QQ_MEMORY_DIR || `${process.env.HOME || process.env.USERPROFILE || '.'}/.deepseek-memory/data`;
const write = process.argv.includes('--write');

const facts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
const episodes = new Map(readEpisodes(dir).map((e) => [e.id, e]));
let checked = 0;
let changed = 0;
for (const f of facts) {
  const epId = f?.source?.episodeId;
  if (!epId || f.status === 'invalidated' || f.status === 'merged') continue;
  const ep = episodes.get(epId);
  if (!ep) continue;
  const quote = String(f.quote || '');
  if (quote.length < 4) continue;
  let rows = [];
  try {
    rows = readTurns(dir, ep.sessionId, { limit: 400 }).filter((r) => {
      const n = Number(r.turn) || 0;
      return n >= (Number(ep.turnFrom) || 0) && n <= (Number(ep.turnTo) || 0);
    });
  } catch { rows = []; }
  const derived = turnAtFor(quote, rows, ep);
  if (!derived) continue;
  checked += 1;
  const current = Number(f.saidAt) || 0;
  if (Math.abs(derived - current) < 10 * 60 * 1000) continue;
  const tp = parseTime(`${quote} ${f.value || ''}`, { refMs: derived, slot: f.slot });
  changed += 1;
  const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`${write ? '修' : '可修'} ${f.id} ${f.slot} ${day(current)} → ${day(derived)} | ${String(f.value).slice(0, 34)}`);
  if (write) {
    lt.appendEvent(
      {
        ev: 'update',
        id: f.id,
        at: Date.now(),
        saidAt: derived,
        dates: tp.dates,
        validUntil: tp.validUntil || 0,
        timePhrase: tp.phrase || '',
        timeConfidence: tp.confidence || 0
      },
      dir
    );
  }
}
console.log(`\n检查 ${checked} 条，${write ? '修正' : '待修'} ${changed} 条`);
