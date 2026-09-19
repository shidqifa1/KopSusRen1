const JAKARTA_TIME_ZONE = 'Asia/Jakarta';

function jakartaParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JAKARTA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type,part.value]));
}

export function jakartaDate(now = new Date(), dayOffset = 0) {
  const parts = jakartaParts(now);
  const date = new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)+dayOffset));
  return date.toISOString().slice(0,10);
}

export function jakartaTime(now = new Date()) {
  const parts = jakartaParts(now);
  return `${parts.hour}:${parts.minute}`;
}

export function addIsoDays(dateValue, days) {
  const match=String(dateValue||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])+days));
  return date.toISOString().slice(0,10);
}

function clock(match) {
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

/**
 * Extract explicit PO fields without treating quantities such as "20 cup" or
 * "2000 ml" as times. The LLM still detects the broad intent; operational
 * values from the owner's text are authoritative here.
 */
export function extractOwnerPoFields(text, now = new Date()) {
  const low = String(text || '').toLowerCase().replace(/\s+/g,' ').trim();
  const openWord = /\b(?:open|buka(?:nya|in|kan)?)\b/.test(low);
  const pendingPoDetails = /\b(?:max(?:imum)?|cup|susu|suus|tutup(?:nya)?|close|besok|hari ini)\b/.test(low);
  const today = /\bhari ini\b/.test(low);
  const tomorrow = /\bbesok\b/.test(low);
  const nowPhrase = /\b(?:sekarang|skrg|skrng|skernag|saat ini)\b/.test(low);
  const openMatch = low.match(/\b(?:open|buka(?:nya|in|kan)?)\b[^0-9]{0,30}?\b(?:jam\s*)?(\d{1,2})[.:](\d{2})\b/);
  const closeMatch = low.match(/\b(?:close|tutup(?:nya)?)\b[^0-9]{0,30}?\b(?:jam\s*)?(\d{1,2})[.:](\d{2})\b/);
  const maxMatch = low.match(/\bmax(?:imum)?(?:\s+limit)?(?:\s+cup)?\s*:?[ ]*(\d{1,3})(?:\s*cup)?\b/)
    || low.match(/\b(?:batas|limit)\s*:?[ ]*(\d{1,3})\s*cup\b/);
  const milkMatch = low.match(/\b(?:susu|suus|susuu)(?:\s+uht)?\b[^0-9]{0,45}?(\d+(?:[.,]\d+)?)\s*ml\b/);
  const ingredientMatch = milkMatch || low.match(/\b(kopi|matcha|gula aren|cup|es)\b[^0-9]{0,35}?(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram|pcs|ml)\b/);

  let ingredientName = null;
  let ingredientQuantity = null;
  if (milkMatch) {
    ingredientName = 'susu';
    ingredientQuantity = Number(milkMatch[1].replace(',','.'));
  } else if (ingredientMatch) {
    ingredientName = ingredientMatch[1];
    ingredientQuantity = Number(ingredientMatch[2].replace(',','.'));
  }

  return {
    wantsOpen: openWord || (pendingPoDetails && (today || tomorrow)),
    date: tomorrow ? jakartaDate(now,1) : today ? jakartaDate(now) : null,
    openTime: nowPhrase && openWord ? jakartaTime(now) : clock(openMatch),
    closeTime: clock(closeMatch),
    maxCups: maxMatch ? Number(maxMatch[1]) : null,
    ingredientName,
    ingredientQuantity: Number.isFinite(ingredientQuantity) && ingredientQuantity > 0 ? ingredientQuantity : null,
  };
}

export function validateOwnerPoSchedule(ownerPo, now = new Date()) {
  const openAt = new Date(`${ownerPo.date}T${ownerPo.openTime}:00+07:00`);
  let closeDate=ownerPo.closeDate||ownerPo.date;
  let closeAt;
  if (Number(ownerPo.durationMinutes)>0&&!Number.isNaN(openAt.getTime())) {
    closeAt=new Date(openAt.getTime()+Number(ownerPo.durationMinutes)*60_000);
    closeDate=closeAt.toLocaleDateString('en-CA',{timeZone:JAKARTA_TIME_ZONE});
  } else {
    closeAt = new Date(`${closeDate}T${ownerPo.closeTime}:00+07:00`);
    const openHour=Number(String(ownerPo.openTime||'').slice(0,2));
    const closeHour=Number(String(ownerPo.closeTime||'').slice(0,2));
    // "00:00" after an evening opening naturally means the upcoming
    // midnight, not midnight that already passed at the start of that date.
    if (closeDate===ownerPo.date&&closeAt<=openAt&&openHour>=18&&closeHour<=6) {
      closeDate=addIsoDays(closeDate,1);
      closeAt=new Date(`${closeDate}T${ownerPo.closeTime}:00+07:00`);
    }
  }
  if (Number.isNaN(openAt.getTime()) || Number.isNaN(closeAt.getTime())) {
    return { ok:false,code:'INVALID_TIME',openAt,closeAt,closeDate };
  }
  // Prefer this error over close-before-open: it tells the owner why a same-day
  // schedule cannot work and which field needs correcting.
  if (closeAt.getTime() <= now.getTime()) {
    return { ok:false,code:'CLOSE_IN_PAST',openAt,closeAt,closeDate };
  }
  if (closeAt.getTime() <= openAt.getTime()) {
    return { ok:false,code:'CLOSE_BEFORE_OPEN',openAt,closeAt,closeDate };
  }
  return { ok:true,openAt,closeAt,closeDate,
    closeTime:closeAt.toLocaleTimeString('en-GB',{timeZone:JAKARTA_TIME_ZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}) };
}
