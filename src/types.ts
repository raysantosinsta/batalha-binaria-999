export enum GameMode {
  COMPETITIVE = 1,
  COOPERATIVE = 2
}

export enum GameStatus {
  SETUP = 'setup',
  SELECTING_PLAYERS = 'selecting_players',
  DISTRIBUTING = 'distributing',
  PLAYING = 'playing',
  VALIDATING = 'validating',
  FINISHED = 'finished'
}

export interface Player {
  id: number;
  name: string;
  score: number;
}

export interface PrivatePlayerData {
  targetDecimal: number;
  targetBinary: string;
}

export interface BoardCell {
  value: number | null;
  ownerId: number | null;
}

export interface GameState {
  mode: GameMode;
  status: GameStatus;
  board: BoardCell[];
  currentPlayerIndex: number;
  drawnBit: number | null;
  players: Player[];
  winner: Player | null;
  lastAction?: string;
  targetDecimalMode2?: number;
  lastDraw?: { playerId: number; value: number; match: boolean };
  winClaimTimerActive: boolean;
  winClaimTimeLeft: number;
}
