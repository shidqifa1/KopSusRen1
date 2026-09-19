import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOwnerPoFields, validateOwnerPoSchedule } from '../services/chatbot/ownerPo.js';

const eveningJakarta = new Date('2026-09-13T14:40:00.000Z');

test('owner PO extractor separates clocks from cup and milk quantities', () => {
  assert.deepEqual(
    extractOwnerPoFields('hari ini buka dair skernag nanti tutupnya jam 15.00,max 20 cup suus cuma bawa 2000ml',eveningJakarta),
    {
      wantsOpen:true,
      date:'2026-09-13',
      openTime:'21:40',
      closeTime:'15:00',
      maxCups:20,
      ingredientName:'susu',
      ingredientQuantity:2000,
    },
  );
});

test('owner PO correction only replaces the field explicitly provided', () => {
  const previous={date:'2026-09-13',openTime:'21:40',closeTime:'15:00',maxCups:20,ingredientQuantity:2000};
  const correction=extractOwnerPoFields('oke bukanya dari jam 12.00',eveningJakarta);
  const merged={
    ...previous,
    ...(correction.date?{date:correction.date}:{}),
    ...(correction.openTime?{openTime:correction.openTime}:{}),
    ...(correction.closeTime?{closeTime:correction.closeTime}:{}),
    ...(correction.maxCups?{maxCups:correction.maxCups}:{}),
    ...(correction.ingredientQuantity?{ingredientQuantity:correction.ingredientQuantity}:{}),
  };
  assert.equal(merged.openTime,'12:00');
  assert.equal(merged.maxCups,20);
  assert.equal(merged.ingredientQuantity,2000);
});

test('schedule validation distinguishes an elapsed cutoff from reversed hours', () => {
  const elapsed=validateOwnerPoSchedule({date:'2026-09-13',openTime:'12:00',closeTime:'15:00'},eveningJakarta);
  assert.equal(elapsed.code,'CLOSE_IN_PAST');
  const reversed=validateOwnerPoSchedule({date:'2026-09-14',openTime:'17:00',closeTime:'15:00'},eveningJakarta);
  assert.equal(reversed.code,'CLOSE_BEFORE_OPEN');
  const valid=validateOwnerPoSchedule({date:'2026-09-14',openTime:'12:00',closeTime:'15:00'},eveningJakarta);
  assert.equal(valid.ok,true);
});

test('midnight and relative duration roll over to the next calendar day', () => {
  const midnight=validateOwnerPoSchedule({date:'2026-09-13',openTime:'23:07',closeTime:'00:00'},eveningJakarta);
  assert.equal(midnight.ok,true);
  assert.equal(midnight.closeDate,'2026-09-14');
  assert.equal(midnight.closeTime,'00:00');
  const oneHour=validateOwnerPoSchedule({date:'2026-09-13',openTime:'23:07',durationMinutes:60},eveningJakarta);
  assert.equal(oneHour.ok,true);
  assert.equal(oneHour.closeDate,'2026-09-14');
  assert.equal(oneHour.closeTime,'00:07');
});
