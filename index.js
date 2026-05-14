require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ]
});

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TASK_PROMPT = `この音声を文字起こしし、タスク情報を抽出してください。

出力は必ず以下のJSON形式のみ:
{
  "task": "タスク内容（50文字以内）",
  "deadline": "YYYY-MM-DDまたはnull",
  "priority": "high/medium/low",
  "category": "仕事/個人/買い物/会議/その他",
  "fullText": "全文文字起こし"
}

期限が言及されていなければdeadlineはnull、優先度は推定してください。`;

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.content !== '!task') return;

const voiceChannel = message.member.voice.channel;
if (!voiceChannel) {
  return message.reply('ボイスチャンネルに入ってから !task を実行してください');
}

console.log('Voice channel:', voiceChannel.name);

  const replyMsg = await message.reply('🎙️ 15秒間録音します...タスクを話してください！');

  try {
    // 簡易版：音声ファイルのアップロードを待つ
    const filter = m => m.author.id === message.author.id && m.attachments.size > 0;
    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
    const msg = collected.first();
    const attachment = msg.attachments.first();
    
    if (!attachment.name.match(/\.(mp3|wav|m4a|ogg)$/i)) {
      return replyMsg.edit('❌ 音声ファイルを添付してください');
    }

    await replyMsg.edit('⏳ 文字起こし & タスク抽出中...');

    // 音声をダウンロード
    const res = await fetch(attachment.url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64Audio = buffer.toString('base64');

    // Geminiで処理
    const result = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        role: 'user',
        parts: [
          { text: TASK_PROMPT },
          { inlineData: { mimeType: 'audio/mp3', data: base64Audio } }
        ]
      }]
    });

    const text = result.text;
    let taskData;
    
    try {
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      taskData = JSON.parse(jsonMatch[0]);
    } catch (e) {
      taskData = {
        task: text.slice(0, 100),
        deadline: null,
        priority: 'medium',
        category: 'その他',
        fullText: text
      };
    }

    // タスクカード作成
    const priorityColors = {
      high: 0xff4444,
      medium: 0xffaa00,
      low: 0x44ff44
    };

    const embed = new EmbedBuilder()
      .setTitle('📋 新規タスク')
      .setDescription(`**${taskData.task}**`)
      .setColor(priorityColors[taskData.priority] || 0x5865f2)
      .addFields(
        { name: '📅 期限', value: taskData.deadline || '未設定', inline: true },
        { name: '⚡ 優先度', value: taskData.priority?.toUpperCase() || 'MEDIUM', inline: true },
        { name: '📁 カテゴリ', value: taskData.category || 'その他', inline: true }
      )
      .setFooter({ text: `by ${message.author.username}` })
      .setTimestamp();

    if (taskData.fullText && taskData.fullText !== taskData.task) {
      embed.addFields({
        name: '📝 全文',
        value: taskData.fullText.slice(0, 1000)
      });
    }

    await message.channel.send({ embeds: [embed] });
    await replyMsg.edit('✅ タスクを登録しました！');

  } catch (error) {
    console.error(error);
    await replyMsg.edit(`❌ エラー: ${error.message}`);
  }
});

client.login(process.env.DISCORD_TOKEN);