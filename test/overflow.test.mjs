import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureWindow, overflowLikely } from '../lib/overflow.js';

describe('overflowLikely', () => {
  it('classifies an explicit too-long prompt', () => {
    assert.equal(overflowLikely('prompt is too long: 100001 tokens > 100000 maximum'), true);
  });

  it('does not classify a generic "context window" mention', () => {
    assert.equal(overflowLikely('check the context window setting'), false);
  });

  it('still matches Gemini business code 11115', () => {
    assert.equal(overflowLikely('RESOURCE_EXHAUSTED: 11115'), true);
  });
});

describe('captureWindow', () => {
  it('learns the upstream maximum', () => {
    assert.equal(captureWindow('prompt is too long: 100001 tokens > 100000 maximum'), 100000);
  });
});
