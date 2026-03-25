import { EventEmitter } from "events";
import type { BaileysEventMap } from "baileys";
import Pino from "pino";
import path from "path";
import qrcode from "qr-image";
import * as glob from "glob";
import fs from "fs";

import {
  IShardOptions,
  IShardConfig,
  ISocketConfig,
  IShardInfoUpdateFields,
  IConnectionUpdate,
} from "../Types/index";

import ShardInfo from "../Utils/ShardInfo";
import ShardError from "../Utils/Error";

const logger = Pino(
  {
    level: "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    base: { pid: false, hostname: false },
  },
  Pino.destination("./baileys-shard-logs.txt")
);

type AsyncFunction = (...args: any[]) => Promise<any>;

function wrapShardError(
  fn: AsyncFunction,
  shardId: string,
  code: string = "UNKNOWN"
): AsyncFunction {
  return async (...args: any[]): Promise<any> => {
    try {
      return await fn(...args);
    } catch (err: any) {
      const shardErr =
        err instanceof ShardError ? err : new ShardError(err.message, code);
      throw shardErr;
    }
  };
}

export default class ShardManager extends EventEmitter {
  #sessionDirectory: string = "./sessions";
  #shards: Map<string, any> = new Map();
  #shardsInfo: Map<string, ShardInfo> = new Map();
  #SocketConfig: ISocketConfig = {}
  private _patched?: boolean;

  constructor(config: IShardConfig = {}) {
    super();
    this.#SocketConfig  = config?.socketConfig;
    this.#sessionDirectory = config?.session || this.#sessionDirectory;
    this.cleanupCorruptSessions().catch(err => {
      logger.error(`Failed to cleanup sessions on startup: ${err}`);
    });
  }

  async checkSessionStatus(sessionDirectory: string): Promise<{
    exists: boolean;
    registered: boolean;
    valid: boolean;
    reason?: string;
  }> {
    try {
      const credsPath = path.join(sessionDirectory, "creds.json");

      if (!fs.existsSync(sessionDirectory) || !fs.existsSync(credsPath)) {
        return { exists: false, registered: false, valid: false };
      }

      const raw = fs.readFileSync(credsPath, "utf8");
      let creds: any;

      try {
        creds = JSON.parse(raw);
      } catch (e) {
        return { 
          exists: true, 
          registered: false, 
          valid: false, 
          reason: "Corrupt JSON" 
        };
      }

      const isRegistered = creds?.registered === true;
      
      const requiredFields = [
        "noiseKey",
        "pairingEphemeralKeyPair", 
        "signedIdentityKey",
        "signedPreKey",
      ];
      const hasRequiredFields = requiredFields.every((f) => creds?.[f]);

      return {
        exists: true,
        registered: isRegistered,
        valid: isRegistered && hasRequiredFields,
        reason: !hasRequiredFields ? "Missing required fields" : undefined
      };
      
    } catch (err) {
      return { 
        exists: true, 
        registered: false, 
        valid: false, 
        reason: `Check error: ${err}` 
      };
    }
  }

  async validateAndCleanSession(sessionDirectory: string): Promise<void> {
    try {
      const status = await this.checkSessionStatus(sessionDirectory);
      
      if (status.valid && status.registered) {
        logger.info(`Session is valid and registered, keeping: ${sessionDirectory}`);
        return;
      }

      if (status.exists && (!status.registered || !status.valid)) {
        logger.warn(`Cleaning invalid session (${status.reason}): ${sessionDirectory}`);
        fs.rmSync(sessionDirectory, { recursive: true, force: true });
      }
      
    } catch (err) {
      logger.error(`validateAndCleanSession error: ${err}`);
      if (fs.existsSync(sessionDirectory)) {
        fs.rmSync(sessionDirectory, { recursive: true, force: true });
      }
    }
  }

  async cleanupCorruptSessions(): Promise<void> {
    try {
      const sessions = glob.sync(this.#sessionDirectory + "/*");
      for (const sessionPath of sessions) {
        await this.validateAndCleanSession(sessionPath);
      }
    } catch (error) {
      logger.error(`Error during session cleanup: ${error}`);
    }
  }

  private setupShardEventHandlers(sock: any, id: string, saveCreds: any, options: IShardOptions) {
    this.#shards.set(id, sock);
    this.#shardsInfo.set(
      id,
      new ShardInfo({
        id,
        index: this.#shards.size,
        total: this.#shards.size,
        phoneNumber: options?.phoneNumber || null,
        status: "initializing",
      })
    );

    const forwardEvents: Array<String> = [
      "messages.upsert",
      "messages.update",
      "messages.delete",
      "messages.reaction",
      "message-receipt.update",
      "messaging-history.set",
      "chats.upsert",
      "chats.update",
      "chats.delete",
      "blocklist.set",
      "blocklist.update",
      "call",
      "contacts.upsert",
      "contacts.update",
      "groups.upsert",
      "groups.update",
      "group-participants.update",
      "presence.update",
    ];

    for (const ev of forwardEvents) {
      sock.ev.on(ev as keyof BaileysEventMap, (data: any) => {
        this.emit(ev as keyof BaileysEventMap, { shardId: id, sock, data });
      });
    }

    sock.ev.on("creds.update", (data: any) => {
      this.emit("creds.update", { shardId: id, sock, data });
    });

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const image = qrcode.imageSync(qr, { type: "png", size: 10, margin: 1 });
        this.emit("login.update", { shardId: id, state: "connecting", type: "qr", image });
      }

      if (connection === "open") {
        const isRegistered = sock?.authState?.creds?.registered ?? false;

        if (!isRegistered) {
          logger.warn(`Session ${id} connected but not registered, recreating...`);
          this.emit("login.update", {
            shardId: id,
            state: "logged_out",
            reason: "Session not registered, clearing session...",
          });
          return await this.recreateShard({ id, ...options, clearSession: true });
        }

        this.#shardsInfo.get(id)?.update({ status: "connected" });
        this.emit("login.update", { shardId: id, state: "connected" });
      }

      if (connection === "close") {
        const isRegistered = sock?.authState?.creds?.registered ?? false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const baileys = await import("baileys");
        const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut;

        if (!isRegistered || !shouldReconnect) {
          logger.warn(`Session ${id} closed and not registered or logged out, clearing...`);
          this.#shardsInfo.get(id)?.update({ status: "logged_out" });
          this.emit("login.update", {
            shardId: id,
            state: "logged_out",
            reason: !isRegistered ? "Session not registered" : "Logged out",
          });
          return await this.recreateShard({ id, ...options, clearSession: true });
        }

        this.#shardsInfo.get(id)?.update({ status: "disconnected" });
        this.emit("login.update", {
          shardId: id,
          state: "disconnected",
          reason: "Connection closed, retrying...",
        });

        setTimeout(() => {
          this.recreateShard({ id, ...options });
        }, 5000);
      }
    });

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        this.emit("login.update", { shardId: id, state: "creds_saved" });
      } catch (err: any) {
        logger.error(`Failed to save creds for ${id}: ${err.message}`);
        this.emit("shard.error", {
          shardId: id,
          error: new ShardError(err.message, "CREDS_SAVE_FAILED"),
        });
      }
    });

    if (options.phoneNumber && !sock.authState.creds?.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(options.phoneNumber ?? "");
          this.emit("login.update", { shardId: id, state: "connecting", type: "pairing", code });
        } catch (err: any) {
          this.emit("shard.error", {
            shardId: id,
            error: new ShardError(err.message, "PAIRING_FAILED"),
          });
        }
      }, 5000);
    }
  }

  async createShard(options: IShardOptions = {}): Promise<{ id: string; sock: any }> {
    try {
      const baileys = await import("baileys");
      const { default: makeWASocket, useMultiFileAuthState } = baileys;
  
      const currentShard = this.#shards.size;
      const id = options?.id || `shard-${currentShard + 1}`;
      const sessionDirectory = path.join(this.#sessionDirectory, id);
  
      if (this.#shards.has(id)) {
        const existingShardInfo = this.#shardsInfo.get(id);
        if (existingShardInfo?.status === "connected" || existingShardInfo?.status === "initializing") {
          logger.info(`Shard ${id} already exists and active, returning existing instance`);
          return { id, sock: this.#shards.get(id) };
        }
      }
  
      const sessionStatus = await this.checkSessionStatus(sessionDirectory);
  
      if (sessionStatus.registered && sessionStatus.valid) {
        logger.info(`Session ${id} is already registered and valid, reusing existing session`);
      } else if (sessionStatus.exists && !sessionStatus.valid) {
        logger.warn(`Session ${id} exists but invalid (${sessionStatus.reason}), cleaning...`);
        await this.validateAndCleanSession(sessionDirectory);
      } else if (!sessionStatus.exists) {
        logger.info(`Creating new session for ${id}`);
      }
  
      let { state, saveCreds } = await useMultiFileAuthState(sessionDirectory);
  
      if (state.creds?.registered === false) {
        logger.warn(`Auth state shows not registered for ${id}, creating fresh session...`);
        if (fs.existsSync(sessionDirectory)) {
          fs.rmSync(sessionDirectory, { recursive: true, force: true });
        }
        const recreated = await useMultiFileAuthState(sessionDirectory);
        state = recreated.state;
        saveCreds = recreated.saveCreds;
      } else if (state.creds?.registered === true) {
        logger.info(`Using existing registered session for ${id}`);
      }
  
      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: !options?.phoneNumber,
        logger,
        ...options?.socket,
      });
  
      this.setupShardEventHandlers(sock, id, saveCreds, options);
      return { id, sock };
    } catch (err: any) {
      const shardErr = new ShardError(`Failed to create shard: ${err.message}`, "CREATE_FAILED");
      this.emit("shard.error", { shardId: options?.id, error: shardErr });
      throw shardErr;
    }
  }

  async recreateShard(options: { 
    id: string; 
    clearSession?: boolean; 
    retryCount?: number; 
    forceRecreate?: boolean;
  } & Partial<ShardOptions>): Promise<{ id: string; sock: any }> {
    const {
      id,
      clearSession = false,
      retryCount = 0,
      forceRecreate = false,
      ...restOptions 
    } = options;
    const maxRetries = 3;
  
    try {
      const sessionDirectory = path.join(this.#sessionDirectory, id);
  
      if (!forceRecreate && !clearSession) {
        const sessionStatus = await this.checkSessionStatus(sessionDirectory);
        if (sessionStatus.registered && sessionStatus.valid) {
          logger.info(`Session ${id} is already registered and valid, skipping recreation`);
          const oldSock = this.#shards.get(id);
          if (oldSock) {
            try {
              if (oldSock.ws) oldSock.ws.close();
              if (typeof oldSock.end === "function") oldSock.end();
            } catch (cleanupErr) {
              logger.warn(`Error cleaning up old socket for ${id}: ${cleanupErr}`);
            }
            this.#shards.delete(id);
            this.#shardsInfo.delete(id);
          }
          await new Promise((r) => setTimeout(r, 2000));
          return await this.createShard({ id, ...restOptions });
        }
      }
  
      const oldSock = this.#shards.get(id);
      if (oldSock) {
        try {
          if (oldSock.ws) oldSock.ws.close();
          if (typeof oldSock.end === "function") oldSock.end();
        } catch (cleanupErr) {
          logger.warn(`Error cleaning up old socket for ${id}: ${cleanupErr}`);
        }
        this.#shards.delete(id);
        this.#shardsInfo.delete(id);
      }
  
      if (clearSession) {
        if (fs.existsSync(sessionDirectory)) {
          fs.rmSync(sessionDirectory, { recursive: true, force: true });
          logger.warn(`Session for ${id} forcefully cleared before recreating`);
        }
      } else {
        await this.validateAndCleanSession(sessionDirectory);
      }
  
      await new Promise((r) => setTimeout(r, 2000));
  
      return await this.createShard({ id, ...restOptions });
    } catch (err: any) {
      if (retryCount < maxRetries) {
        logger.warn(`Retrying recreate shard ${id} (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, 5000 * (retryCount + 1)));
        return await this.recreateShard({
          ...options,
          retryCount: retryCount + 1,
          clearSession: retryCount >= 2,
        });
      }
  
      const shardErr = new ShardError(
        `Failed to recreate shard after ${maxRetries} attempts: ${err.message}`,
        "RECREATE_FAILED"
      );
      this.emit("shard.error", { shardId: id, error: shardErr });
      throw shardErr;
    }
  }

  async getSessionInfo(id: string): Promise<{
    exists: boolean;
    registered: boolean;
    valid: boolean;
    reason?: string;
  }> {
    const sessionDirectory = path.join(this.#sessionDirectory, id);
    return await this.checkSessionStatus(sessionDirectory);
  }
    
  async connect(id: string): Promise<{ id: string; sock: any }> {
    return wrapShardError(this.recreateShard.bind(this), id, "CONNECT_FAILED")({ id });
  }

  async stopShard(id: string): Promise<boolean> {
    const sock = this.#shards.get(id);
    if (!sock) {
      const err = new ShardError(`Shard ${id} not found`, "SHARD_NOT_FOUND");
      this.emit("shard.error", { shardId: id, error: err });
      throw err;
    }

    try {
      if (sock.ws) sock.ws.close();
      if (typeof sock.end === "function") sock.end();
      this.#shards.delete(id);
      this.#shardsInfo.get(id)?.update({ status: "stopped" });
      return true;
    } catch (err: any) {
      const shardErr = new ShardError(`Failed to stop shard ${id}: ${err.message}`, "STOP_FAILED");
      this.emit("shard.error", { shardId: id, error: shardErr });
      throw shardErr;
    }
  }

  async loadAllShards(): Promise<string[]> {
    try {
      const sessions = glob.sync(this.#sessionDirectory + "/*");
      const ids: string[] = [];

      if (!sessions.length) {
        const err = new ShardError("No sessions found", "NO_SESSIONS");
        this.emit("shard.error", { shardId: null, error: err });
      }

      for (const file of sessions) {
        const shardId = path.basename(file);
        try {
          const { id } = await this.createShard({ id: shardId });
          ids.push(id);
        } catch (err: any) {
          this.emit("shard.error", {
            shardId,
            error: new ShardError(err.message, "LOAD_FAILED"),
          });
        }
      }

      return ids;
    } catch (err: any) {
      const shardErr = new ShardError(`Failed to load shards: ${err.message}`, "LOAD_FAILED");
      this.emit("shard.error", { shardId: null, error: shardErr });
      return [];
    }
  }

  socket(id: string): any | undefined {
    return this.#shards.get(id);
  }

  shard(id: string): EventEmitter | null {
    const sock = this.#shards.get(id);
    if (!sock) return null;

    const emitter = new EventEmitter();
    this.onAny((event: string, payload: any) => {
      if (payload?.shardId === id) {
        emitter.emit(event, payload);
      }
    });
    return emitter;
  }

  onAny(listener: (event: string, ...args: any[]) => void): void {
    const origEmit = this.emit;
    if (this._patched) return;
    this.emit = (event: string | symbol, ...args: any[]): boolean => {
      listener(event as string, ...args);
      return origEmit.call(this, event, ...args);
    };
    this._patched = true;
  }

  getShardInfo(id: string): IShardInfo | null {
    return this.#shardsInfo.get(id) || null;
  }

  getAllShardInfo(): IShardInfo[] {
    return Array.from(this.#shardsInfo.values());
  }
}
