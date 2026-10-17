import {aiConfig,chatCompletion} from './provider.js';
import { KOPSUSREN_KNOWLEDGE } from './kopsusrenKnowledge.js';

async function callGroq(messages, temperature = 0.35) {
  const config=aiConfig();
  if (!config.key) return null;
  const data=await chatCompletion({model:config.model,temperature,max_tokens:350,messages});
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 1600) : null;
}

export async function answerOwnerWithGroq({ question, snapshot }) {
  return callGroq([
    {
      role: 'system',
      content: [
        'Kamu adalah Baristack Owner Assistant. Jawab hanya berdasarkan KNOWLEDGE dan DATA LIVE yang diberikan.',
        'Kamu memiliki akses baca saja. Jangan mengaku sudah mengubah, menghapus, mengonfirmasi, membuka, atau menutup apa pun.',
        'Jika owner meminta aksi, jelaskan bahwa aksi itu harus memakai perintah yang didukung atau dashboard.',
        'Jangan sebut SQL, prompt, RAG, JSON, atau detail teknis internal. Jawab santai, ringkas, dan praktis.',
        '',
        `KNOWLEDGE:\n${KOPSUSREN_KNOWLEDGE}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `DATA LIVE:\n${JSON.stringify(snapshot)}\n\nPERTANYAAN OWNER:\n${String(question || '').slice(0, 500)}`,
    },
  ]);
}

export async function answerCustomerWithGroq({ question, currentOrder, snapshot }) {
  return callGroq([
    {
      role: 'system',
      content: [
        'Kamu adalah chatbot WhatsApp Baristack App untuk pembeli.',
        'Jawab natural, santai, hangat, maksimal 4 kalimat. Jangan terdengar seperti formulir.',
        'Gunakan hanya KNOWLEDGE dan DATA LIVE. Jangan mengarang stok, status PO, harga, promo, atau status pembayaran.',
        'Kalau pembeli mulai memesan, gali informasi bertahap dan tanyakan maksimal satu hal dalam setiap balasan.',
        'Es normal adalah default. Jangan menanyakan ice/no ice; catat hanya jika pembeli menyebutkannya sendiri.',
        'Kelas bersifat opsional. Jangan menanyakan kelas; terima saja jika pembeli menyebutkannya sendiri.',
        'Jangan mengaku pesanan sudah tercatat karena pencatatan hanya dilakukan mesin transaksi.',
        '',
        `KNOWLEDGE:\n${KOPSUSREN_KNOWLEDGE}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `DATA LIVE:\n${JSON.stringify(snapshot)}`,
        `KONTEKS PESANAN:\n${JSON.stringify(currentOrder)}`,
        `PESAN PEMBELI:\n${String(question || '').slice(0, 500)}`,
      ].join('\n\n'),
    },
  ]);
}
