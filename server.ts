process.env.TZ = 'Asia/Shanghai';

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  readAndParseCsv,
  calculateCsvAverages,
  detectChannelTypeCode,
  getChannelMeta,
  lttbDownsample,
  extractCollectionTimestamp,
} from './server/csv_parser.js';
import { seedInitialData, generateSampleCsv, seedMultiDeviceSamples } from './server/sample_generator.js';
import { FtpBackgroundScanner } from './server/ftp_scanner.js';
import { resolveWindowsOrNativePath } from './server/local_watcher.js';
import { AppConfig, TrendPoint, HotspotAnchor, ChannelTypeCode, FtpConnectionConfig, DeviceInfo, DataFolderInfo } from './src/types.js';

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Path constants
const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const CACHE_PATH = path.resolve(process.cwd(), 'data_cache.json');
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const DEFAULT_FTP_DIR = path.resolve(process.cwd(), 'data_ftp');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Serve uploaded images statically
app.use('/uploads', express.static(UPLOADS_DIR));

// Default App Config
const defaultConfig: AppConfig = {
  thresholds: {
    ch1_damage_warning: 30,
    ch1_damage_alarm: 60,
    ch1_lubrication_warning: 60,
    ch1_lubrication_alarm: 80,

    ch2_damage_warning: 30,
    ch2_damage_alarm: 60,
    ch2_lubrication_warning: 60,
    ch2_lubrication_alarm: 80,

    ch3_type: 'Ballscrew',
    ch3_damage_warning: 30,
    ch3_damage_alarm: 60,
    ch3_lubrication_warning: 60,
    ch3_lubrication_alarm: 80,
  },
  hotspots: [
    {
      id: 'ch1_damage',
      name: '通道1 导轨滑块',
      channel: 'CH1',
      metric: 'damage',
      axis: 'X',
      x: 22,
      y: 38,
      z: 15,
    },
    {
      id: 'ch1_lubrication',
      name: '通道1 导轨润滑油槽',
      channel: 'CH1',
      metric: 'lubrication',
      axis: 'X',
      x: 32,
      y: 42,
      z: 18,
    },
    {
      id: 'ch2_damage',
      name: '通道2 导轨滑块',
      channel: 'CH2',
      metric: 'damage',
      axis: 'Y',
      x: 52,
      y: 38,
      z: 35,
    },
    {
      id: 'ch2_lubrication',
      name: '通道2 导轨润滑油槽',
      channel: 'CH2',
      metric: 'lubrication',
      axis: 'Y',
      x: 62,
      y: 42,
      z: 38,
    },
    {
      id: 'ch3_damage',
      name: '通道3 丝杆轴承座',
      channel: 'CH3',
      metric: 'damage',
      axis: 'Z',
      x: 78,
      y: 58,
      z: 65,
    },
  ],
  equipment_image_url: '',
  ftp_folder: DEFAULT_FTP_DIR,
  ftp_connection: {
    enabled: false,
    host: '',
    port: 21,
    user: 'anonymous',
    password: '',
    remote_path: '/',
    passive: true,
    delete_remote_after_download: false,
    auto_scan: true,
  },
  poll_interval_sec: 10,
  auto_sim_active: false,
};

// Config manager
function loadConfig(): AppConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...defaultConfig, ...JSON.parse(data) };
    } catch (e) {
      console.error('Failed to parse config.json, using default');
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
  return defaultConfig;
}

function saveConfig(cfg: AppConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let currentConfig = loadConfig();

// Cache Manager for Dimensionality Reduction
// Logical session state management (PROTECTS LOCAL DISK FILES FROM BEING DELETED)
// 允许加载与持久化磁盘上的已有历史数据包，不再强制清空已存文件与缓存
let dataClearedTimestamp: number = 0;
let ignoredFiles = new Set<string>();
let alarmClearedTimestamp: number = 0;

interface CacheData {
  [filename: string]: {
    mtimeMs: number;
    sizeBytes?: number;
    trendPoint: TrendPoint;
  };
}

function loadCache(): CacheData {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveCache(cache: CacheData) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Helper: Ensure valid directory path on Windows physical disks or local filesystem
function getSafeFtpDir(folderPath: string): string {
  return resolveWindowsOrNativePath(folderPath);
}

// Helper: Clean all CSV files in FTP directories and reset cache
function clearAllFtpCsvFiles() {
  const dirs = new Set<string>();
  dirs.add(getSafeFtpDir(currentConfig.ftp_folder));
  dirs.add(path.resolve(DEFAULT_FTP_DIR));
  dirs.add(path.resolve('./data_ftp'));

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const csvs = getAllCsvFiles(dir, dir);
      for (const item of csvs) {
        try {
          if (fs.existsSync(item.filePath)) {
            fs.unlinkSync(item.filePath);
          }
        } catch (e) {}
      }
    }
  }
}

// Background FTP & Data Directory Auto-Scanner Singleton
const ftpScanner = new FtpBackgroundScanner({
  configGetter: () => currentConfig,
  cacheLoader: loadCache,
  cacheSaver: saveCache,
  safeDirGetter: getSafeFtpDir,
  dataClearedTimestampGetter: () => dataClearedTimestamp,
  ignoredFilesGetter: () => ignoredFiles,
  onDataUpdated: (newCount) => {
    console.log(`[FTP Background Scanner] 自动成功扫描解析 ${newCount} 个新 CSV 文件`);
  },
});

// Start background scanning task and file watcher immediately
ftpScanner.start(currentConfig.poll_interval_sec || 10);
ftpScanner.watchLocalDirectory(currentConfig.ftp_folder || DEFAULT_FTP_DIR);

// Multer Storage Configuration for Equipment Image Uploads
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `equipment_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage: imageStorage });

// CSV Folder Upload Configuration - Preserves Subdirectory Structure!
const directoryUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ftpDir = getSafeFtpDir(currentConfig.ftp_folder);
    if (!fs.existsSync(ftpDir)) {
      try {
        fs.mkdirSync(ftpDir, { recursive: true });
      } catch (e) {
        console.warn('Failed to create directory:', ftpDir, e);
      }
    }
    // file.originalname may contain relative paths from webkitdirectory, e.g. "CSVdata/GSAA123/sample.csv" or "GSAA123/sample.csv"
    const normalized = file.originalname.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    let targetDir = ftpDir;
    if (parts.length > 2) {
      // Strips top folder (the selected root folder name) and keeps secondary folder(s)
      const subDir = parts.slice(1, -1).join(path.sep);
      targetDir = path.join(ftpDir, subDir);
    } else if (parts.length === 2) {
      // E.g. "GSAA123/sample.csv" -> subfolder GSAA123
      targetDir = path.join(ftpDir, parts[0]);
    }

    if (!fs.existsSync(targetDir)) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (e) {
        console.warn('Failed to create sub directory:', targetDir, e);
      }
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const normalized = file.originalname.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const filename = parts.length > 0 ? parts[parts.length - 1] : path.basename(file.originalname);
    cb(null, filename);
  },
});
const directoryUpload = multer({ storage: directoryUploadStorage });
const csvStorage = directoryUploadStorage;
const csvUpload = directoryUpload;

interface CsvFileInfo {
  filename: string;
  filePath: string;
  device_sn: string;
}

// Helper: Recursively find all CSV files and extract device_sn from the immediate child directory of baseDir
function getAllCsvFiles(
  dirPath: string,
  baseDir: string = dirPath,
  depth: number = 0
): CsvFileInfo[] {
  if (depth > 5 || !fs.existsSync(dirPath)) return [];
  let filesList: CsvFileInfo[] = [];
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      const nameLower = item.name.toLowerCase();
      // Skip node_modules, uploads, dist, hidden dirs
      if (
        nameLower === 'node_modules' ||
        nameLower === 'uploads' ||
        nameLower === 'dist' ||
        nameLower.startsWith('.')
      ) {
        continue;
      }
      if (item.isDirectory()) {
        filesList = filesList.concat(getAllCsvFiles(fullPath, baseDir, depth + 1));
      } else if (item.isFile() && nameLower.endsWith('.csv')) {
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        // Extract top-level subfolder inside baseDir as the device_sn (e.g., 'SN-DEV-001/file.csv' -> 'SN-DEV-001')
        const parts = rel.split('/').filter(Boolean);
        let device_sn = 'DEFAULT';
        if (parts.length > 1) {
          device_sn = parts[0];
        } else {
          // If in root, check if the parent folder has a meaningful name
          const parentDir = path.basename(path.dirname(fullPath));
          if (parentDir && parentDir !== 'data_ftp' && parentDir !== '.' && !parentDir.startsWith('.')) {
            device_sn = parentDir;
          }
        }
        filesList.push({ filename: rel, filePath: fullPath, device_sn });
      }
    }
  } catch (err) {
    console.warn(`Error scanning directory ${dirPath}:`, err);
  }
  return filesList;
}

// Helper: Scan all CSV directories strictly within the user's selected/configured main directory
function getAllConfiguredCsvFiles(): CsvFileInfo[] {
  const dirsToScan = new Set<string>();

  const safeDir = getSafeFtpDir(currentConfig.ftp_folder);
  if (fs.existsSync(safeDir)) {
    dirsToScan.add(safeDir);
  }

  try {
    const rawPath = path.resolve(currentConfig.ftp_folder);
    if (fs.existsSync(rawPath)) {
      dirsToScan.add(rawPath);
    }
  } catch (e) {
    // Ignore invalid paths
  }

  // Map keyed by physical absolute canonical file path on disk
  const realPathMap = new Map<string, CsvFileInfo>();

  for (const dir of dirsToScan) {
    if (fs.existsSync(dir)) {
      const files = getAllCsvFiles(dir, dir);
      for (const f of files) {
        let canonicalPath = f.filePath;
        try {
          canonicalPath = fs.realpathSync(f.filePath);
        } catch (e) {
          canonicalPath = path.resolve(f.filePath);
        }

        if (ignoredFiles.has(f.filename) || ignoredFiles.has(canonicalPath) || ignoredFiles.has(path.basename(f.filePath))) {
          continue;
        }

        if (dataClearedTimestamp > 0) {
          try {
            const stat = fs.statSync(f.filePath);
            const colDate = extractCollectionTimestamp(f.filename, [], stat.mtime);
            const dataTime = colDate.getTime();
            if (dataTime <= dataClearedTimestamp) {
              continue;
            }
          } catch (e) {
            continue;
          }
        }

        if (!realPathMap.has(canonicalPath)) {
          realPathMap.set(canonicalPath, {
            filename: f.filename,
            filePath: f.filePath,
            device_sn: f.device_sn,
          });
        }
      }
    }
  }

  const result = Array.from(realPathMap.values());
  return result;
}

// Dynamic Device Discovery & Status Aggregator
function scanDeviceList(trendPoints: TrendPoint[] = []): DeviceInfo[] {
  const deviceMap = new Map<string, DeviceInfo>();
  const ftpDir = getSafeFtpDir(currentConfig.ftp_folder);

  // 1. Dynamic scan of all subdirectories in the root folder (each directory is an SN)
  if (fs.existsSync(ftpDir)) {
    try {
      const items = fs.readdirSync(ftpDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const name = item.name.trim();
          const lower = name.toLowerCase();
          if (
            lower !== 'node_modules' &&
            lower !== 'uploads' &&
            lower !== 'dist' &&
            !lower.startsWith('.')
          ) {
            deviceMap.set(name, {
              sn: name,
              name: `设备 ${name}`,
              fileCount: 0,
              pointCount: 0,
              status: 'normal',
              alarmCount: 0,
              path: path.join(ftpDir, name),
            });
          }
        }
      }
    } catch (e) {
      console.warn('Error reading root directory for device subfolders:', e);
    }
  }

  // 2. Discover devices from all detected CSV files
  const allFiles = getAllConfiguredCsvFiles();
  for (const f of allFiles) {
    const sn = f.device_sn || 'DEFAULT';
    if (!deviceMap.has(sn)) {
      deviceMap.set(sn, {
        sn,
        name: sn === 'DEFAULT' ? '默认主设备 (根目录)' : `设备 ${sn}`,
        fileCount: 0,
        pointCount: 0,
        status: 'normal',
        alarmCount: 0,
      });
    }
    const dev = deviceMap.get(sn)!;
    dev.fileCount += 1;
  }

  // 3. Correlate with trend points for status & timestamps
  for (const pt of trendPoints) {
    const sn = pt.device_sn || 'DEFAULT';
    if (!deviceMap.has(sn)) {
      deviceMap.set(sn, {
        sn,
        name: sn === 'DEFAULT' ? '默认主设备 (根目录)' : `设备 ${sn}`,
        fileCount: 0,
        pointCount: 0,
        status: 'normal',
        alarmCount: 0,
      });
    }
    const dev = deviceMap.get(sn)!;
    dev.pointCount += 1;
    if (!dev.latestMtimeMs || pt.mtimeMs > dev.latestMtimeMs) {
      dev.latestMtimeMs = pt.mtimeMs;
      dev.latestMtime = pt.mtime;
    }
    if (pt.is_alarm) {
      dev.status = 'alarm';
      dev.alarmCount += 1;
    } else if (pt.is_warning && dev.status !== 'alarm') {
      dev.status = 'warning';
    }
  }

  // If no devices found, ensure at least a default device exists
  if (deviceMap.size === 0) {
    deviceMap.set('DEFAULT', {
      sn: 'DEFAULT',
      name: '默认主设备',
      fileCount: 0,
      pointCount: 0,
      status: 'normal',
      alarmCount: 0,
    });
  }

  return Array.from(deviceMap.values()).sort((a, b) => a.sn.localeCompare(b.sn));
}

// Dynamic Scan of all data storage folders located directly under the main directory
function scanMainDataFolders(trendPoints: TrendPoint[] = []): DataFolderInfo[] {
  const ftpDir = getSafeFtpDir(currentConfig.ftp_folder);
  const folderMap = new Map<string, DataFolderInfo>();

  // 1. Scan subfolders directly under main directory (主目录)
  if (fs.existsSync(ftpDir)) {
    try {
      const items = fs.readdirSync(ftpDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const name = item.name.trim();
          const lower = name.toLowerCase();
          if (
            lower !== 'node_modules' &&
            lower !== 'uploads' &&
            lower !== 'dist' &&
            !lower.startsWith('.')
          ) {
            const subPath = path.join(ftpDir, name);
            const relPath = path.relative(ftpDir, subPath).replace(/\\/g, '/');
            folderMap.set(name, {
              folderName: name,
              displayName: name,
              relativePath: relPath,
              fullPath: subPath,
              csvCount: 0,
              totalSizeBytes: 0,
              status: 'normal',
              alarmCount: 0,
              isRoot: false,
            });
          }
        }
      }
    } catch (e) {
      console.warn('Error reading root directory for subfolders:', e);
    }
  }

  // 2. Discover CSV files and map to folders
  const allFiles = getAllConfiguredCsvFiles();
  let rootCsvCount = 0;
  let rootSizeBytes = 0;
  for (const f of allFiles) {
    const fName = f.device_sn || 'DEFAULT';
    let statSize = 0;
    try {
      statSize = fs.statSync(f.filePath).size;
    } catch {}

    if (fName === 'DEFAULT' || fName === '.' || fName === '__ROOT__') {
      rootCsvCount++;
      rootSizeBytes += statSize;
    } else {
      if (!folderMap.has(fName)) {
        folderMap.set(fName, {
          folderName: fName,
          displayName: fName,
          relativePath: fName,
          fullPath: path.join(ftpDir, fName),
          csvCount: 0,
          totalSizeBytes: 0,
          status: 'normal',
          alarmCount: 0,
          isRoot: false,
        });
      }
      const folder = folderMap.get(fName)!;
      folder.csvCount += 1;
      folder.totalSizeBytes += statSize;
    }
  }

  // If there are CSVs located directly in the root directory, provide it as a choice
  if (rootCsvCount > 0) {
    folderMap.set('__ROOT__', {
      folderName: '__ROOT__',
      displayName: '主目录直属文件 (根目录)',
      relativePath: '.',
      fullPath: ftpDir,
      csvCount: rootCsvCount,
      totalSizeBytes: rootSizeBytes,
      status: 'normal',
      alarmCount: 0,
      isRoot: true,
    });
  }

  // 3. Correlate with trendPoints for status, timestamps & alarms
  for (const pt of trendPoints) {
    const fName = (pt.device_sn === 'DEFAULT' || pt.device_sn === '.' || !pt.device_sn)
      ? '__ROOT__'
      : pt.device_sn;

    if (folderMap.has(fName)) {
      const folder = folderMap.get(fName)!;
      if (!folder.latestMtimeMs || pt.mtimeMs > folder.latestMtimeMs) {
        folder.latestMtimeMs = pt.mtimeMs;
        folder.latestMtime = pt.mtime;
      }
      if (pt.is_alarm) {
        folder.status = 'alarm';
        folder.alarmCount += 1;
      } else if (pt.is_warning && folder.status !== 'alarm') {
        folder.status = 'warning';
      }
    }
  }

  const list = Array.from(folderMap.values());
  return list.sort((a, b) => {
    if (a.isRoot) return 1;
    if (b.isRoot) return -1;
    return a.folderName.localeCompare(b.folderName, 'zh-CN');
  });
}

async function processFtpDirectory(): Promise<TrendPoint[]> {
  const ftpDir = getSafeFtpDir(currentConfig.ftp_folder);
  if (!fs.existsSync(ftpDir)) {
    try {
      fs.mkdirSync(ftpDir, { recursive: true });
    } catch (e) {
      console.warn('Could not create directory:', ftpDir, e);
    }
  }

  const csvEntries = getAllConfiguredCsvFiles();
  if (csvEntries.length === 0) {
    return [];
  }

  const cache = loadCache();
  let cacheUpdated = false;
  const trendPoints: TrendPoint[] = [];

  for (const entry of csvEntries) {
    const { filename, filePath, device_sn } = entry;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch (e) {
      continue;
    }

    const mtimeMs = stats.mtimeMs;

    // Use cached result if file timestamp hasn't changed
    if (cache[filename] && cache[filename].mtimeMs === mtimeMs) {
      const colDate = extractCollectionTimestamp(filename, [], stats.mtime);
      cache[filename].trendPoint.mtime = colDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      cache[filename].trendPoint.mtimeMs = colDate.getTime();
      cache[filename].trendPoint.device_sn = device_sn;
      trendPoints.push(cache[filename].trendPoint);
      continue;
    }

    // Otherwise, read and parse file to aggregate
    try {
      const { validHeaders, rows } = await readAndParseCsv(filePath, 3, device_sn);
      if (rows.length === 0) continue;

      const point = calculateCsvAverages(
        filename,
        stats.mtime,
        validHeaders,
        rows,
        device_sn
      );

      cache[filename] = {
        mtimeMs,
        trendPoint: point,
      };
      cacheUpdated = true;
      trendPoints.push(point);
    } catch (err) {
      console.error(`Error processing CSV ${filename}:`, err);
    }
  }

  if (cacheUpdated) {
    saveCache(cache);
  }

  // Sort by mtime ascending for trend line rendering
  trendPoints.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // Evaluate alarms against current thresholds dynamically for channels 1..3
  const th = currentConfig.thresholds;
  for (const pt of trendPoints) {
    pt.is_alarm = false;
    pt.is_warning = false;
    pt.alarm_details = [];

    // Dynamically check channels 1 to 3
    for (let i = 1; i <= 3; i++) {
      const chKey = `ch${i}` as 'ch1' | 'ch2' | 'ch3';
      const typeCode: ChannelTypeCode =
        pt.channel_types?.[chKey] ||
        (pt[`ch${i}_type_code` as keyof TrendPoint] as ChannelTypeCode) ||
        (pt[`ch${i}_type` as keyof TrendPoint] === 'Ballscrew' ? 'S' : pt[`ch${i}_type` as keyof TrendPoint] === 'Disabled' ? 'E' : 'G');

      // 'E' = Disabled channel: ignore alarms completely
      if (typeCode === 'E') {
        continue;
      }

      const isScrew = typeCode === 'S';
      const chLabel = isScrew ? `通道${i} 滚珠丝杆` : `通道${i} 直线导轨`;

      // Check Damage
      const damageVal = pt[`ch${i}_damage_avg` as keyof TrendPoint] as number | null;
      const dmgWarn = typeof (th as any)[`ch${i}_damage_warning`] === 'number' ? (th as any)[`ch${i}_damage_warning`] : 0;
      const dmgAlarm = typeof (th as any)[`ch${i}_damage_alarm`] === 'number' ? (th as any)[`ch${i}_damage_alarm`] : 0;

      if (typeof damageVal === 'number' && !isNaN(damageVal)) {
        if (damageVal >= dmgAlarm) {
          pt.is_alarm = true;
          pt.alarm_details.push(
            `${chLabel}破损超限 (${damageVal.toFixed(1)} >= ${dmgAlarm})`
          );
        } else if (damageVal >= dmgWarn) {
          pt.is_warning = true;
        }
      }

      // Check Lubrication (only for G / Guide)
      if (typeCode === 'G') {
        const lubVal = pt[`ch${i}_lubrication_avg` as keyof TrendPoint] as number | null;
        const lubWarn = typeof (th as any)[`ch${i}_lubrication_warning`] === 'number' ? (th as any)[`ch${i}_lubrication_warning`] : 0;
        const lubAlarm = typeof (th as any)[`ch${i}_lubrication_alarm`] === 'number' ? (th as any)[`ch${i}_lubrication_alarm`] : 0;

        if (typeof lubVal === 'number' && !isNaN(lubVal)) {
          if (lubVal >= lubAlarm) {
            pt.is_alarm = true;
            pt.alarm_details.push(
              `${chLabel}润滑超限 (${lubVal.toFixed(1)} >= ${lubAlarm})`
            );
          } else if (lubVal >= lubWarn) {
            pt.is_warning = true;
          }
        }
      }
    }

    // If user clicked "Clear Alarm", suppress active alarm flags for historical points up to the clear timestamp
    if (alarmClearedTimestamp > 0 && pt.mtimeMs <= alarmClearedTimestamp) {
      pt.is_alarm = false;
      pt.is_warning = false;
      pt.alarm_details = [];
    }
  }

  return trendPoints;
}

// Background auto simulator timer
let simIntervalTimer: NodeJS.Timeout | null = null;
function updateAutoSimulator() {
  if (currentConfig.auto_sim_active) {
    if (!simIntervalTimer) {
      simIntervalTimer = setInterval(async () => {
        try {
          const targetFtpDir = getSafeFtpDir(currentConfig.ftp_folder);
          if (!fs.existsSync(targetFtpDir)) {
            fs.mkdirSync(targetFtpDir, { recursive: true });
          }
          generateSampleCsv(targetFtpDir, {
            ch3Type: currentConfig.thresholds.ch3_type,
            isAlarm: false,
            sampleCount: 1200,
            baseDate: new Date(),
          });
          await ftpScanner.scan();
        } catch (e) {
          console.warn('[AutoSimulator Error]', e);
        }
      }, 3000);
    }
  } else {
    if (simIntervalTimer) {
      clearInterval(simIntervalTimer);
      simIntervalTimer = null;
    }
  }
}

// API Routes

// GET config
app.get('/api/config', (req, res) => {
  res.json({ status: 'ok', config: currentConfig });
});

// POST config (thresholds / ftp directory / remote FTP connection / polling interval)
app.post('/api/config', async (req, res) => {
  const { thresholds, ftp_folder, ftp_connection, poll_interval_sec, auto_sim_active } = req.body;
  if (thresholds) currentConfig.thresholds = { ...currentConfig.thresholds, ...thresholds };
  let pathChanged = false;
  if (ftp_folder && ftp_folder !== currentConfig.ftp_folder) {
    currentConfig.ftp_folder = ftp_folder;
    saveCache({}); // Invalidate cache when changing target FTP directory
    pathChanged = true;
  }
  // Rebind or ensure watcher on folder
  if (pathChanged || ftp_folder) {
    ftpScanner.watchLocalDirectory(currentConfig.ftp_folder);
  }
  if (ftp_connection) {
    currentConfig.ftp_connection = {
      ...(currentConfig.ftp_connection || {
        enabled: false,
        host: '',
        port: 21,
        user: 'anonymous',
        password: '',
        remote_path: '/',
        passive: true,
        delete_remote_after_download: false,
        auto_scan: true,
      }),
      ...ftp_connection,
    };
  }
  if (poll_interval_sec) {
    currentConfig.poll_interval_sec = Math.max(2, Number(poll_interval_sec));
    ftpScanner.start(currentConfig.poll_interval_sec);
  }
  if (typeof auto_sim_active === 'boolean') currentConfig.auto_sim_active = auto_sim_active;

  saveConfig(currentConfig);
  updateAutoSimulator();
  res.json({ status: 'ok', config: currentConfig });
});

// POST watch-folder: explicitly activate and rebind real-time local file watcher
app.post('/api/watch-folder', async (req, res) => {
  try {
    const { folderPath } = req.body;
    const target = folderPath || currentConfig.ftp_folder;
    currentConfig.ftp_folder = target;
    saveConfig(currentConfig);
    const watchResult = ftpScanner.watchLocalDirectory(target);
    const trends = await processFtpDirectory();
    res.json({
      status: 'ok',
      message: watchResult.message,
      watchResult,
      totalCount: trends.length,
      currentFiles: trends.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET check_new_data: lightweight polling endpoint for automatic UI synchronization
app.get('/api/check_new_data', async (req, res) => {
  try {
    const clientVersion = Number(req.query.since_version) || 0;
    const scannerStatus = ftpScanner.getStatus();
    const hasNewData = scannerStatus.dataVersion > clientVersion;

    res.json({
      status: 'ok',
      hasNewData,
      dataVersion: scannerStatus.dataVersion,
      newFilesCount: scannerStatus.lastNewFilesCount,
      totalParsedFiles: scannerStatus.totalParsedFiles,
      lastScanTime: scannerStatus.lastScanTime,
      isScanning: scannerStatus.isScanning,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST trigger immediate manual scan of FTP server & local folders
app.post('/api/ftp/scan-now', async (req, res) => {
  try {
    // Reset logical filter on explicit manual rescan so all files on disk are reloaded
    dataClearedTimestamp = 0;
    ignoredFiles.clear();
    const scanResult = await ftpScanner.scan();
    const trends = await processFtpDirectory();
    res.json({
      status: 'ok',
      message: `扫描完成！本次新拾取 ${scanResult.newFilesCount} 个文件，当前共加载 ${trends.length} 个数据包`,
      scanResult,
      count: trends.length,
      latest: trends.length > 0 ? trends[trends.length - 1] : null,
      trends,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST test FTP server connection credentials
app.post('/api/ftp/test-connection', async (req, res) => {
  try {
    const ftpConfig: FtpConnectionConfig = req.body.ftp_connection || req.body;
    const result = await ftpScanner.testFtpConnection(ftpConfig);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || String(err) });
  }
});

// GET FTP scanner status and logs
app.get('/api/ftp/status', (req, res) => {
  res.json({
    status: 'ok',
    scannerStatus: ftpScanner.getStatus(),
    ftpFolder: currentConfig.ftp_folder,
    ftpConnection: currentConfig.ftp_connection,
    pollIntervalSec: currentConfig.poll_interval_sec,
  });
});

// POST hotspots config
app.post('/api/config/hotspots', (req, res) => {
  const { hotspots } = req.body;
  if (Array.isArray(hotspots)) {
    currentConfig.hotspots = hotspots;
    saveConfig(currentConfig);
  }
  res.json({ status: 'ok', config: currentConfig });
});

// POST upload equipment image
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }
  const imageUrl = `/uploads/${req.file.filename}`;
  currentConfig.equipment_image_url = imageUrl;
  saveConfig(currentConfig);
  res.json({ status: 'ok', imageUrl });
});

// GET devices list (Dynamic scan of root subfolders + file data tags)
app.get('/api/devices', async (req, res) => {
  try {
    const trends = await processFtpDirectory();
    const devices = scanDeviceList(trends);
    res.json({
      status: 'ok',
      totalDevices: devices.length,
      devices,
      defaultDevice: devices.length > 0 ? devices[0].sn : 'DEFAULT',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET data folders list under main directory
app.get('/api/data-folders', async (req, res) => {
  try {
    const trends = await processFtpDirectory();
    const folders = scanMainDataFolders(trends);
    const totalCsvFiles = getAllConfiguredCsvFiles().length;
    res.json({
      status: 'ok',
      mainDirectory: currentConfig.ftp_folder,
      safeMainDirectory: getSafeFtpDir(currentConfig.ftp_folder),
      totalFolders: folders.length,
      folders,
      totalCsvFiles,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST scan main directory explicitly and auto parse all subfolders
app.post('/api/scan-main-directory', async (req, res) => {
  try {
    dataClearedTimestamp = 0;
    ignoredFiles.clear();
    const scanResult = await ftpScanner.scan();
    const allTrends = await processFtpDirectory();
    const folders = scanMainDataFolders(allTrends);
    res.json({
      status: 'ok',
      message: `主目录扫描完成！在目录 [${currentConfig.ftp_folder}] 发现 ${folders.length} 个数据存放文件夹，共 ${allTrends.length} 个数据包`,
      mainDirectory: currentConfig.ftp_folder,
      folders,
      totalTrends: allTrends.length,
      scanResult,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create a new subfolder under main directory
app.post('/api/create-subfolder', async (req, res) => {
  try {
    const rawName = ((req.body?.folderName as string) || '').trim();
    if (!rawName) {
      return res.status(400).json({ error: '文件夹名称不能为空' });
    }
    const folderName = path.basename(rawName);
    const mainDir = getSafeFtpDir(currentConfig.ftp_folder);
    const targetDir = path.join(mainDir, folderName);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    if (req.body?.generateSample) {
      generateSampleCsv(mainDir, {
        deviceSn: folderName,
        ch3Type: currentConfig.thresholds.ch3_type,
        isAlarm: false,
        sampleCount: 1200,
        baseDate: new Date(),
      });
    }
    await ftpScanner.scan();
    const allTrends = await processFtpDirectory();
    const folders = scanMainDataFolders(allTrends);
    res.json({
      status: 'ok',
      message: `已在主目录创建文件夹 [${folderName}] 并完成扫描`,
      folderName,
      folders,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET trends (Long term averaged trend data with optional folder or device_sn filtering)
app.get('/api/trends', async (req, res) => {
  try {
    const allTrends = await processFtpDirectory();
    const devices = scanDeviceList(allTrends);
    const folders = scanMainDataFolders(allTrends);
    const targetFolder = ((req.query.folder as string) || (req.query.device_sn as string) || '').trim();

    let filteredTrends = allTrends;
    if (targetFolder && targetFolder !== 'ALL') {
      if (targetFolder === '__ROOT__') {
        filteredTrends = allTrends.filter(
          (p) => !p.device_sn || p.device_sn === 'DEFAULT' || p.device_sn === '__ROOT__' || p.device_sn === '.'
        );
      } else {
        filteredTrends = allTrends.filter(
          (p) => p.device_sn === targetFolder || p.folderName === targetFolder
        );
      }
    }

    res.json({
      status: 'ok',
      count: filteredTrends.length,
      totalCount: allTrends.length,
      latest: filteredTrends.length > 0 ? filteredTrends[filteredTrends.length - 1] : null,
      trends: filteredTrends,
      folders,
      devices,
      selectedFolder: targetFolder || 'ALL',
      selectedDevice: targetFolder || 'ALL',
      mainDirectory: currentConfig.ftp_folder,
      detectedCh3Hardware: currentConfig.thresholds.ch3_type,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET csv files list (Reverse chronological with optional folder or device_sn filtering)
app.get('/api/csv-files', (req, res) => {
  const csvEntries = getAllConfiguredCsvFiles();
  const targetFolder = ((req.query.folder as string) || (req.query.device_sn as string) || '').trim();

  const fileInfos = csvEntries
    .filter((entry) => {
      if (!targetFolder || targetFolder === 'ALL') return true;
      if (targetFolder === '__ROOT__') {
        return !entry.device_sn || entry.device_sn === 'DEFAULT' || entry.device_sn === '__ROOT__' || entry.device_sn === '.';
      }
      return entry.device_sn === targetFolder;
    })
    .map((entry) => {
      try {
        const stat = fs.statSync(entry.filePath);
        const colDate = extractCollectionTimestamp(entry.filename, [], stat.mtime);
        return {
          filename: entry.filename,
          device_sn: entry.device_sn,
          folderName: entry.device_sn,
          mtime: colDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
          mtimeMs: colDate.getTime(),
          sizeBytes: stat.size,
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

  fileInfos.sort((a, b) => b!.mtimeMs - a!.mtimeMs);
  res.json({ status: 'ok', files: fileInfos, totalCount: csvEntries.length });
});

// POST upload CSV files from local folder directly into FTP directory
app.post('/api/upload-csv-folder', csvUpload.array('files', 500), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '没有接收到有效 CSV 文件' });
    }
    await ftpScanner.scan();
    const trends = await processFtpDirectory();
    const folders = scanMainDataFolders(trends);
    const devices = scanDeviceList(trends);
    res.json({
      status: 'ok',
      message: `成功导入 ${files.length} 个 CSV 文件，已自动通过二级文件夹区分 ${folders.length} 个设备`,
      uploadedCount: files.length,
      folders,
      devices,
      trends,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST upload entire chosen folder from user's machine (via HTML5 folder picker)
// Automatically creates the subfolders as device data sources
app.post('/api/upload-selected-directory', directoryUpload.array('files', 1000), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '没有接收到有效文件' });
    }
    await ftpScanner.scan();
    const trends = await processFtpDirectory();
    const folders = scanMainDataFolders(trends);
    const devices = scanDeviceList(trends);
    res.json({
      status: 'ok',
      message: `已成功载入您手动选择的目录（包含 ${files.length} 个数据文件），已自动按二级文件夹区分 ${folders.length} 个设备数据！`,
      uploadedCount: files.length,
      folders,
      devices,
      trends,
      totalCsvFiles: folders.reduce((sum, f) => sum + f.csvCount, 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST dynamically set and switch main directory manually without presets
app.post('/api/set-main-directory', async (req, res) => {
  try {
    const { directoryPath } = req.body;
    if (!directoryPath || typeof directoryPath !== 'string') {
      return res.status(400).json({ error: '请提供有效的目录路径' });
    }
    const cleanPath = directoryPath.trim();
    currentConfig.ftp_folder = cleanPath;
    saveConfig(currentConfig);

    // Re-initialize local watcher on the newly chosen directory
    ftpScanner.watchLocalDirectory(cleanPath);

    // Reset memory cache to ensure only the selected directory's data is parsed
    dataClearedTimestamp = 0;
    ignoredFiles.clear();

    await ftpScanner.scan();
    const trends = await processFtpDirectory();
    const folders = scanMainDataFolders(trends);
    const devices = scanDeviceList(trends);

    res.json({
      status: 'ok',
      message: `已成功切换为主监控目录 [${cleanPath}]，已自动识别并区分 ${folders.length} 个设备文件夹！`,
      mainDirectory: cleanPath,
      folders,
      devices,
      trends,
      totalCsvFiles: folders.reduce((sum, f) => sum + f.csvCount, 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET subdirectories list for folder path picker
app.get('/api/directories', (req, res) => {
  try {
    let rawDir = ((req.query.dir as string) || './data_ftp').trim();
    // Normalize backslashes for Windows
    rawDir = rawDir.replace(/\\/g, '/');

    const isWinDrive = /^[a-zA-Z]:/.test(rawDir);
    const isPosixAbs = rawDir.startsWith('/');
    const isAbs = isWinDrive || isPosixAbs || path.isAbsolute(rawDir);

    const targetPath = isAbs ? rawDir : path.resolve(process.cwd(), rawDir);

    if (!fs.existsSync(targetPath)) {
      try {
        fs.mkdirSync(targetPath, { recursive: true });
      } catch (e) {
        // Continue even if disk drive root or restricted directory
      }
    }

    let subdirs: string[] = [];
    if (fs.existsSync(targetPath)) {
      try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        subdirs = items
          .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
          .map((item) => item.name);
      } catch (e) {
        console.warn('Cannot read directory:', targetPath, e);
      }
    }

    let relativePath: string;
    let parentRelativePath: string;

    if (isAbs) {
      relativePath = targetPath;
      const parentDir = path.dirname(targetPath).replace(/\\/g, '/');
      parentRelativePath = parentDir || targetPath;
    } else {
      const rel = path.relative(process.cwd(), targetPath).replace(/\\/g, '/') || '.';
      relativePath = rel.startsWith('.') ? rel : `./${rel}`;

      const parentDir = path.dirname(targetPath);
      const parentRel = path.relative(process.cwd(), parentDir).replace(/\\/g, '/') || '.';
      parentRelativePath = parentRel.startsWith('.') ? parentRel : `./${parentRel}`;
    }

    res.json({
      status: 'ok',
      currentPath: targetPath,
      relativePath,
      parentRelativePath,
      subdirs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET csv detail (Single group raw waveform view with device_sn)
app.get('/api/csv-detail/:filename(*)', async (req, res) => {
  try {
    const filename = req.params.filename || (req.params as any)[0];
    const safeFtpDir = getSafeFtpDir(currentConfig.ftp_folder);
    let filePath = path.join(safeFtpDir, filename);
    let deviceSn = '';

    const csvEntries = getAllConfiguredCsvFiles();
    const match = csvEntries.find(
      (e) =>
        e.filename === filename ||
        path.basename(e.filePath) === path.basename(filename) ||
        e.filePath === filePath
    );

    if (match) {
      filePath = match.filePath;
      deviceSn = match.device_sn;
    } else if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `CSV file not found: ${filename}` });
    }

    if (!deviceSn) {
      const parentDir = path.basename(path.dirname(filePath));
      deviceSn = parentDir && parentDir !== '.' && parentDir !== 'data_ftp' ? parentDir : 'DEFAULT';
    }

    const { validHeaders, rows, device_sn } = await readAndParseCsv(filePath, 3, deviceSn);

    const ch1TypeCode = detectChannelTypeCode(validHeaders, rows, 1);
    const ch2TypeCode = detectChannelTypeCode(validHeaders, rows, 2);
    const ch3TypeCode = detectChannelTypeCode(validHeaders, rows, 3);

    const ch1Meta = getChannelMeta(1, ch1TypeCode);
    const ch2Meta = getChannelMeta(2, ch2TypeCode);
    const ch3Meta = getChannelMeta(3, ch3TypeCode);

    const detectedObjects = {
      ch1: currentConfig.thresholds.ch1_name || ch1Meta.displayName,
      ch2: currentConfig.thresholds.ch2_name || ch2Meta.displayName,
      ch3: currentConfig.thresholds.ch3_name || ch3Meta.displayName,
    };

    // Perform LTTB downsampling for micro waveform view if rows > 1200
    const downsampledRows = lttbDownsample(rows, 1200);

    res.json({
      status: 'ok',
      filename,
      device_sn,
      rowCount: rows.length,
      downsampled: downsampledRows.length < rows.length,
      columns: validHeaders,
      channel_types: {
        ch1: ch1TypeCode,
        ch2: ch2TypeCode,
        ch3: ch3TypeCode,
      },
      detectedHardware: {
        ch1: ch1Meta.hardwareType,
        ch2: ch2Meta.hardwareType,
        ch3: ch3Meta.hardwareType,
      },
      detectedObjects,
      // Send max 100 rows for data grid preview to keep JSON snappy, full waveform uses downsampledRows
      previewRows: rows.slice(0, 100),
      rows: downsampledRows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Simulation Trigger Endpoints (支持按设备 SN 单独或多设备批量生成测试数据包)
app.post('/api/sim/generate', async (req, res) => {
  try {
    const targetFtpDir = getSafeFtpDir(currentConfig.ftp_folder);
    if (!fs.existsSync(targetFtpDir)) {
      fs.mkdirSync(targetFtpDir, { recursive: true });
    }
    const requestedDevice = ((req.body?.device_sn as string) || '').trim();
    const filename = generateSampleCsv(targetFtpDir, {
      deviceSn: requestedDevice || 'SN-DEV-001',
      ch3Type: currentConfig.thresholds.ch3_type,
      isAlarm: false,
      sampleCount: 1200,
      baseDate: new Date(),
    });
    const fullPath = path.join(targetFtpDir, filename);
    await ftpScanner.processSingleFile(fullPath, filename);
    const trends = await processFtpDirectory();
    res.json({
      status: 'ok',
      filename,
      device_sn: requestedDevice || 'GSAA123',
      fullPath,
      count: trends.length,
      latest: trends.length > 0 ? trends[trends.length - 1] : null,
      message: `已成功为采集器 [${requestedDevice || 'GSAA123'}] 生成 1 个模拟数据包: ${filename}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sim/alarm', async (req, res) => {
  try {
    const targetFtpDir = getSafeFtpDir(currentConfig.ftp_folder);
    if (!fs.existsSync(targetFtpDir)) {
      fs.mkdirSync(targetFtpDir, { recursive: true });
    }
    const requestedDevice = ((req.body?.device_sn as string) || '').trim();
    const filename = generateSampleCsv(targetFtpDir, {
      deviceSn: requestedDevice || 'GSAA456',
      ch3Type: currentConfig.thresholds.ch3_type,
      isAlarm: true,
      sampleCount: 1200,
      baseDate: new Date(),
    });
    const fullPath = path.join(targetFtpDir, filename);
    await ftpScanner.processSingleFile(fullPath, filename);
    const trends = await processFtpDirectory();
    res.json({
      status: 'ok',
      filename,
      device_sn: requestedDevice || 'GSAA456',
      fullPath,
      count: trends.length,
      latest: trends.length > 0 ? trends[trends.length - 1] : null,
      message: `已成功为采集器 [${requestedDevice || 'GSAA456'}] 生成 1 个报警模拟数据包: ${filename}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Seed multi-device mock scenario (GSAA123, GSAA456)
app.post('/api/sim/seed-multi-device', async (req, res) => {
  try {
    const targetFtpDir = getSafeFtpDir(currentConfig.ftp_folder);
    const generated = seedMultiDeviceSamples(targetFtpDir);
    // Trigger immediate background scanner scan
    await ftpScanner.scan();
    const trends = await processFtpDirectory();
    const devices = scanDeviceList(trends);
    res.json({
      status: 'ok',
      message: `已成功初始化采集器二级目录 (GSAA123, GSAA456) 与测试数据包`,
      generatedFiles: generated,
      devices,
      trendsCount: trends.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sim/toggle', async (req, res) => {
  try {
    currentConfig.auto_sim_active = !currentConfig.auto_sim_active;
    saveConfig(currentConfig);
    updateAutoSimulator();
    if (currentConfig.auto_sim_active) {
      await ftpScanner.scan();
    }
    res.json({
      status: 'ok',
      auto_sim_active: currentConfig.auto_sim_active,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Data Packages & Cache
app.post('/api/data/clear', async (req, res) => {
  try {
    // 1. Turn off auto simulation if active
    currentConfig.auto_sim_active = false;
    updateAutoSimulator();
    saveConfig(currentConfig);

    // 2. Clean up CSV files across all FTP and local data directories
    try {
      clearAllFtpCsvFiles();
    } catch (cleanErr) {
      console.warn('Error cleaning FTP csv files:', cleanErr);
    }

    // 3. Clear in-memory / disk cache structure
    saveCache({});

    // 4. Reset markers
    dataClearedTimestamp = 0;
    ignoredFiles.clear();

    alarmClearedTimestamp = Date.now();
    ftpScanner.dataVersion = Date.now();
    ftpScanner.lastNewFilesCount = 0;
    ftpScanner.addLog(
      'info',
      '用户执行了清空：已重置数据缓存并清理数据包，监听器继续就绪'
    );

    res.json({
      status: 'ok',
      message: '已成功清空当前已加载的数据与缓存',
      deletedCount: 0,
      count: 0,
      trends: [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Single CSV File Endpoint (LOGICAL REMOVAL ONLY)
app.post('/api/csv-file/delete', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    // Logical ignore only - protect user's physical CSV files
    ignoredFiles.add(filename);

    // Clear cache entry
    const cache = loadCache();
    if (cache[filename]) {
      delete cache[filename];
      saveCache(cache);
    }

    ftpScanner.dataVersion = Date.now();

    res.json({
      status: 'ok',
      deleted: true,
      filename,
      message: `已从当前视图中逻辑移除 ${filename}（物理磁盘原始文件已安全保留）`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Alarms / Manual Reset
app.post('/api/alarms/clear', async (req, res) => {
  try {
    alarmClearedTimestamp = Date.now();

    // Update cache on disk as well so cleared alarm status persists across cache loads
    const cache = loadCache();
    let cacheChanged = false;
    for (const filename of Object.keys(cache)) {
      if (cache[filename] && cache[filename].trendPoint) {
        cache[filename].trendPoint.is_alarm = false;
        cache[filename].trendPoint.is_warning = false;
        cache[filename].trendPoint.alarm_details = [];
        cacheChanged = true;
      }
    }
    if (cacheChanged) {
      saveCache(cache);
    }

    const trends = await processFtpDirectory();
    res.json({
      status: 'ok',
      message: '已手动消警，清除当前所有触发的报警状态',
      alarmClearedTimestamp,
      trends,
      latest: trends.length > 0 ? trends[trends.length - 1] : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear/Reset Custom Equipment Image
app.post('/api/config/reset-image', (req, res) => {
  currentConfig.equipment_image_url = '';
  saveConfig(currentConfig);
  res.json({ status: 'ok', config: currentConfig, message: '已恢复默认设备结构配图' });
});

// Reset Thresholds to Zero (恢复默认 / 一键清零)
app.post('/api/config/reset-thresholds', (req, res) => {
  currentConfig.thresholds = {
    ...currentConfig.thresholds,
    ch1_damage_warning: 0,
    ch1_damage_alarm: 0,
    ch1_lubrication_warning: 0,
    ch1_lubrication_alarm: 0,

    ch2_damage_warning: 0,
    ch2_damage_alarm: 0,
    ch2_lubrication_warning: 0,
    ch2_lubrication_alarm: 0,

    ch3_damage_warning: 0,
    ch3_damage_alarm: 0,
    ch3_lubrication_warning: 0,
    ch3_lubrication_alarm: 0,
  };
  saveConfig(currentConfig);
  res.json({ status: 'ok', config: currentConfig, message: '已一键清零所有通道预警与超限阈值(0)' });
});

// Reset Hotspots to Default
app.post('/api/config/reset-hotspots', (req, res) => {
  currentConfig.hotspots = [...defaultConfig.hotspots];
  saveConfig(currentConfig);
  res.json({ status: 'ok', config: currentConfig, message: '已重置数字孪生传感器热点位置' });
});

// Vite Development or Production Server Integration
async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Equipment Health Monitoring Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
