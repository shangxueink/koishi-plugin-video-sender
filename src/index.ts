import { Context, Schema, h } from 'koishi'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';

// 根据调试结果，这是 ffmpeg v1.1.0 服务的正确类型
interface FFmpegService {
  executable: string;
}

declare module 'koishi' {
  interface Context {
    ffmpeg: FFmpegService;
  }
}

export const name = 'video-sender'
export const inject = ['ffmpeg']

export interface Config {
  path: string;
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.path({
    allowCreate: true,
    filters: ['directory']
  })
    .default('./data/videoTemp')
    .description("视频缓存文件所在的文件夹路径")
    .required(),
})

export const usage = `
会将所有视频格式极速转换为 mkv (需要 ffmpeg 插件 v1.1.0)。
`

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('video-sender')
  const tempFolderPath = path.join(ctx.baseDir, config.path)

  if (!fs.existsSync(tempFolderPath)) {
    fs.mkdirSync(tempFolderPath, { recursive: true })
  }

  // 定期清理旧文件逻辑可以保持不变
  // ...

  ctx.command('发送视频 <videoUrl:string>', '通过视频链接发送视频')
    .action(async ({ session }, videoUrl) => {
      if (!session) return '该命令无法在没有会话的上下文中使用。';
      if (!videoUrl) return '请提供视频链接。';
      if (!ctx.ffmpeg?.executable) return 'ffmpeg 可执行文件路径未找到，请检查 ffmpeg 插件是否已正确配置。';
      
      let downloadedPath: string | null = null;
      let remuxedPath: string | null = null;

      try {
        await session.send(h.text('视频处理中，请稍候...'));
        
        const downloadResult = await downloadVideo(videoUrl);
        if (!downloadResult.success || !downloadResult.path) {
          return `视频下载失败: ${downloadResult.error}`;
        }
        downloadedPath = downloadResult.path;

        logger.info(`开始将 ${downloadedPath} 转封装为 mkv...`);
        const remuxResult = await remuxToMkv(downloadedPath);
        if (!remuxResult.success || !remuxResult.path) {
          return `视频转封装失败: ${remuxResult.error}`;
        }
        remuxedPath = remuxResult.path;
        
        logger.info('转封装成功!');
        
        const videoBuffer = fs.readFileSync(remuxedPath);
        const dataURI = `data:video/x-matroska;base64,${videoBuffer.toString('base64')}`;
        await session.send(h.video(dataURI));

      } catch (error) {
        logger.error('处理视频时发生未知错误:', error);
        return '处理视频时发生未知错误。';
      } finally {
        if (downloadedPath) fs.promises.unlink(downloadedPath).catch(e => logger.error('清理原始文件失败:', e));
        if (remuxedPath) fs.promises.unlink(remuxedPath).catch(e => logger.error('清理转封装文件失败:', e));
      }
    })

  async function downloadVideo(url: string): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      let extension = '.tmp';
      try {
        const urlObject = new URL(url);
        const detectedExt = path.extname(urlObject.pathname).split('?')[0];
        if (detectedExt) extension = detectedExt;
      } catch (e) { /* url可能不是标准格式，忽略错误 */ }

      const filePath = path.join(tempFolderPath, `${uuidv4()}${extension}`);
      const response = await ctx.http.get(url, { responseType: 'arraybuffer' });
      fs.writeFileSync(filePath, Buffer.from(response));
      logger.info(`视频已下载到: ${filePath}`);
      return { success: true, path: filePath };
    } catch (error) {
      logger.error('下载视频失败:', error);
      return { success: false, error: error instanceof Error ? error.message : '未知下载错误' };
    }
  }

  // 使用注入的 ffmpeg 路径，通过 child_process 执行转封装
  function remuxToMkv(inputPath: string): Promise<{ success: boolean; path?: string; error?: string }> {
    return new Promise((resolve) => {
      const outputPath = path.join(tempFolderPath, `${uuidv4()}.mkv`);
      // 使用插件提供的确切路径
      const ffmpegPath = ctx.ffmpeg.executable;
      // 为路径加上引号，防止路径中有空格导致命令失败
      const command = `"${ffmpegPath}" -y -i "${inputPath}" -c copy "${outputPath}"`;

      exec(command, (error) => {
        if (error) {
          logger.error('FFmpeg 转封装失败:', error);
          resolve({ success: false, error: error.message });
        } else {
          resolve({ success: true, path: outputPath });
        }
      });
    });
  }
}