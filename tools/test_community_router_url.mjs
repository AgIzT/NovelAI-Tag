import assert from 'node:assert/strict';
import {
  communityUrlForRoute,
  readCommunityUrlState,
} from '../site/assets/community/router.js';
import {
  COMMUNITY_NSFW_PREFERENCE_KEY,
  canShowCommunityEntry,
  hasAdultNsfwConfirmation,
  shouldRestoreCommunityNsfw,
} from '../site/assets/community/state.js';
import {
  ADULT_CONFIRMATION_STORAGE_KEY,
  NSFW_STORAGE_KEY,
} from '../site/assets/app/state.js';

assert.deepEqual(readCommunityUrlState(''), { entry: '', imageIndex: 0 });
assert.deepEqual(readCommunityUrlState('?entry=post-1'), { entry: 'post-1', imageIndex: 0 });
assert.deepEqual(readCommunityUrlState('?entry=post-1&image=3'), { entry: 'post-1', imageIndex: 2 });
assert.deepEqual(readCommunityUrlState('?entry=%20%20&image=8'), { entry: '', imageIndex: 0 });
assert.deepEqual(readCommunityUrlState('?entry=post-1&image=-4'), { entry: 'post-1', imageIndex: 0 });
assert.deepEqual(readCommunityUrlState('?entry=post-1&image=2.9'), { entry: 'post-1', imageIndex: 1 });
assert.deepEqual(readCommunityUrlState('?entry=post-1&image=not-a-number'), { entry: 'post-1', imageIndex: 0 });

const base = 'https://example.com/strings.html?utm_source=chat#gallery';
assert.equal(
  communityUrlForRoute({ entry: 'post / 1', imageIndex: 0 }, base),
  '/strings.html?utm_source=chat&entry=post+%2F+1#gallery',
);
assert.equal(
  communityUrlForRoute({ entry: 'post-1', imageIndex: 2 }, base),
  '/strings.html?utm_source=chat&entry=post-1&image=3#gallery',
);
assert.equal(
  communityUrlForRoute({ entry: 'post-1', imageIndex: 2.9 }, base),
  '/strings.html?utm_source=chat&entry=post-1&image=3#gallery',
);
assert.equal(
  communityUrlForRoute({ entry: '', imageIndex: 9 }, 'https://example.com/strings.html?entry=old&image=4&x=1'),
  '/strings.html?x=1',
);

const nsfwRead = values => key => values.get(key) ?? null;
assert.notEqual(ADULT_CONFIRMATION_STORAGE_KEY, NSFW_STORAGE_KEY);
assert.equal(hasAdultNsfwConfirmation(nsfwRead(new Map([[ADULT_CONFIRMATION_STORAGE_KEY, '1']]))), true);
assert.equal(
  hasAdultNsfwConfirmation(nsfwRead(new Map([[NSFW_STORAGE_KEY, '1']]))),
  true,
  '旧主站已解锁状态可单向作为成年确认凭证',
);
assert.equal(shouldRestoreCommunityNsfw(nsfwRead(new Map([
  [COMMUNITY_NSFW_PREFERENCE_KEY, 'true'],
  [ADULT_CONFIRMATION_STORAGE_KEY, '1'],
]))), true);
assert.equal(shouldRestoreCommunityNsfw(nsfwRead(new Map([
  [COMMUNITY_NSFW_PREFERENCE_KEY, 'true'],
]))), false, '旧版单击偏好不能充当成人确认');
assert.equal(canShowCommunityEntry({ id: 'safe' }, false), true);
assert.equal(canShowCommunityEntry({ id: 'adult', nsfw: true }, false), false);
assert.equal(canShowCommunityEntry({ id: 'adult', nsfw: true }, true), true);

console.log('community router URL tests passed');
