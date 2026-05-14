require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');
const {
  joinVoiceChannel,
  EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpegStatic = require('ffmpeg-static');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// 録音状態を管理
const recordings = new Map();

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // ============ !task: 録音開始 ============
  if (message.content === '!task') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('ボイスチャンネルに入ってから !task を実行してください');
    }

    if (recordings.has(message.guild.id)) {
      return message.reply('既に録音中です。!stop で終了してください');
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });

      const pcmPath = path.join('/tmp', `rec_${Date.now()}.pcm`);
      const pcmStream = fs.createWriteStream(pcmPath);

      const receiver = connection.receiver;
      const opusStream = receiver.subscribe(message.author.id, {
        end: { behavior: EndBehaviorType.Manual },
      });

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });

      // デバッグ: 音声パケット受信を可視化
      opusStream.on('data', (chunk) => {
        console.log(`Opus chunk: ${chunk.length} bytes`);
      });

      opusStream.pipe(decoder).pipe(pcmStream);

      recordings.set(message.guild.id, {
        pcmPath,
        connection,
        userId: message.author.id,
        channel: message.channel,
        opusStream,
        pcmStream,
      });

      console.log(`録音開始: ${voiceChannel.name}, user=${message.author.username}`);
      await message.reply('🔴 録音中... 話し終わったら `!stop` を送ってください');
    } catch (err) {
      console.error('録音開始エラー:', err);
      await message.reply(`❌ 録音開始失敗: ${err.message}`);
    }
    return;
  }

  // ============ !stop: 録音停止 + 文字起こし ============
  if (message.content === '!stop') {
    const rec = recordings.get(message.guild?.id);
    if (!rec) {
      return message.reply('録音していません。!task で開始してください');
    }
    if (rec.userId !== message.author.id) {
      return message.reply('録音を開始した人だけが停止できます');
    }

    const replyMsg = await message.reply('⏳ 録音停止 → 変換 → 文字起こし中...');

    try {
      // 1. Opusストリームを正常終了（push(null)で終端を通知）
      rec.opusStream.push(null);

      // 2. PCMファイルの書き込み完了を待つ
      await new Promise(resolve => {
        rec.pcmStream.on('close', resolve);
        rec.pcmStream.on('finish', resolve);
        setTimeout(resolve, 3000); // 念のためのタイムアウト
      });

      // 3. ボイス切断
      rec.connection.destroy();
      recordings.delete(message.guild.id);

      const pcmSize = fs.statSync(rec.pcmPath).size;
      console.log('PCMサイズ:', pcmSize);

      if (pcmSize < 1000) {
        fs.unlinkSync(rec.pcmPath);
        return replyMsg.edit('❌ 録音された音声がほぼ無音でした。マイクを確認してください');
      }

      // PCM → MP3 変換
      const mp3Path = rec.pcmPath.replace('.pcm', '.mp3');
      await new Promise((resolve, reject) => {
        const ff = spawn(ffmpegStatic, [
          '-y',
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          '-i', rec.pcmPath,
          '-codec:a', 'libmp3lame',
          '-b:a', '64k',
          mp3Path,
        ]);
        ff.stderr.on('data', d => console.log('[ffmpeg]', d.toString().slice(0, 200)));
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
        ff.on('error', reject);
      });

      fs.unlinkSync(rec.pcmPath);
      console.log('MP3変換完了:', mp3Path);

      // Gemini送信
      const buffer = fs.readFileSync(mp3Path);
      const base64Audio = buffer.toString('base64');
      fs.unlinkSync(mp3Path);

      const result = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [
            { text: TASK_PROMPT },
            { inlineData: { mimeType: 'audio/mpeg', data: base64Audio } }
          ]
        }]
      });

      const text = typeof result.text === 'function' ? result.text() : result.text;
      console.log('Gemini応答:', text?.slice(0, 300));

      let taskData;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        taskData = JSON.parse(jsonMatch[0]);
      } catch (e) {
        taskData = {
          task: text.slice(0, 100),
          deadline: null,
          priority: 'medium',
          category: 'その他',
          fullText: text,
        };
      }

      const priorityColors = { high: 0xff4444, medium: 0xffaa00, low: 0x44ff44 };
      const embed = new EmbedBuilder()
        .setTitle('📋 新規タスク')
        .setDescription(`**${taskData.task}**`)
        .setColor(priorityColors[taskData.priority] || 0x5865f2)
        .addFields(
          { name: '📅 期限', value: taskData.deadline || '未設定', inline: true },
          { name: '⚡ 優先度', value: (taskData.priority || 'medium').toUpperCase(), inline: true },
          { name: '📁 カテゴリ', value: taskData.category || 'その他', inline: true }
        )
        .setFooter({ text: `by ${message.author.username}` })
        .setTimestamp();

      if (taskData.fullText && taskData.fullText !== taskData.task) {
        embed.addFields({ name: '📝 全文', value: taskData.fullText.slice(0, 1000) });
      }

      await message.channel.send({ embeds: [embed] });
      await replyMsg.edit('✅ タスクを登録しました！');

    } catch (error) {
      console.error('=== ERROR ===', error);
      try { fs.unlinkSync(rec.pcmPath); } catch {}
      let msg = error.message || '不明なエラー';
      if (error.status === 429) msg = 'API使用上限。明日17時(JST)にリセット';
      await replyMsg.edit(`❌ エラー: ${msg}`);
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);