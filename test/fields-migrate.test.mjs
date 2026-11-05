import test from 'node:test';
import assert from 'node:assert/strict';
import { planFieldUpdate, planReview } from '../src/fields-migrate.mjs';

const fact = (over = {}) => ({ id: 'h-1', topicId: 't-study', slot: 'note', value: '', text: '', about: 'user', ...over });

test('单条课表 → t-study/course', () => {
  const up = planFieldUpdate(fact({ value: '周五早八示例基础课，在示例楼A507' }));
  assert.ok(up);
  assert.equal(up.topicId, 't-study');
  assert.equal(up.slot, 'course');
});

test('课程拼句不拆，只进 review', () => {
  const f = fact({ value: '本学期课程：数理方法、体育、理论力学、光学' });
  assert.equal(planFieldUpdate(f), null);
  const rv = planReview(f);
  assert.ok(rv);
  assert.ok(rv.notes.some((n) => n.includes('拆成多条 course')));
});

test('考试情报 → exam（主题不变）', () => {
  const f = fact({ topicId: 't-hust', slot: 'intel', value: '华光 081200 人工智能：拟招 30 人（含推免）、初试 101/201/301/832' });
  const up = planFieldUpdate(f);
  assert.ok(up);
  assert.equal(up.topicId, 't-hust');
  assert.equal(up.slot, 'exam');
});

test('已有 exam 且无其它变化 → 不产生 update', () => {
  assert.equal(planFieldUpdate(fact({ topicId: 't-hust', slot: 'exam', value: '初试 101/201/301/832' })), null);
});

test('短专业事实 → major；长句仍留在原位并进 review', () => {
  const short = planFieldUpdate(fact({ topicId: 't-plan', slot: 'plan', value: '考研目标计算机专业' }));
  assert.ok(short);
  assert.equal(short.slot, 'major');
  const long = fact({ topicId: 't-plan', slot: 'stance', value: '想转向电子信息或AI方向，以华光网安毕业的亲戚为榜样，高中起的目标' });
  const up = planFieldUpdate(long);
  // 长句不改槽位；但若抽出机构（华光），允许只补 entities
  if (up) {
    assert.equal(up.slot, 'stance');
    assert.ok(up.reasons.includes('补 entities'));
  }
  assert.ok(planReview(long));
});
