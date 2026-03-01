import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, RotateCcw, Play, Users, Cpu, Info, ChevronRight, Hash, Share2, UserCheck, Lock } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { GameMode, GameStatus, GameState, Player, PrivatePlayerData } from './types';
import { generateBoard, getRandomInt, decimalToBinary, checkBitCorrectness, binaryToDecimal } from './utils';

const BOARD_SIZE = 8;
const ROOM_ID = window.location.pathname === '/' ? 'global-battle' : window.location.pathname.replace('/', '');

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const isRemoteUpdate = useRef(false);

  const [gameState, setGameState] = useState<GameState>({
    mode: GameMode.COMPETITIVE,
    status: GameStatus.SETUP,
    board: generateBoard(BOARD_SIZE),
    currentPlayerIndex: 0,
    drawnBit: null,
    players: [
      { id: 1, name: 'Jogador 1', score: 0 },
      { id: 2, name: 'Jogador 2', score: 0 },
    ],
    winner: null,
    winClaimTimerActive: false,
    winClaimTimeLeft: 0
  });

  const [shakeIndex, setShakeIndex] = useState<number | null>(null);
  const [revealedCards, setRevealedCards] = useState<number[]>([]);
  const [showWinClaimModal, setShowWinClaimModal] = useState(false);
  const [isWinClaimMinimized, setIsWinClaimMinimized] = useState(false);
  
  // Private and Slot State
  const [myPlayerId, setMyPlayerId] = useState<number | null>(null);
  const [myPrivateData, setMyPrivateData] = useState<PrivatePlayerData | null>(null);
  const [slotAssignments, setSlotAssignments] = useState<[number, string][]>([]);

  // Socket initialization
  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-room', ROOM_ID);
    });

    socket.on('game-state', (remoteState: GameState) => {
      isRemoteUpdate.current = true;
      setGameState(prev => {
        // If turn passed in cooperative mode, clear our private data
        if (remoteState.mode === GameMode.COOPERATIVE && remoteState.currentPlayerIndex !== prev.currentPlayerIndex) {
          setMyPrivateData(null);
        }
        return remoteState;
      });
      setTimeout(() => { isRemoteUpdate.current = false; }, 50);
    });

    socket.on('slot-assignments', (assignments: [number, string][]) => {
      setSlotAssignments(assignments);
      // If our socket is in the assignments, update myPlayerId
      const myAssignment = assignments.find(([_, sid]) => sid === socket.id);
      if (myAssignment) {
        setMyPlayerId(myAssignment[0]);
      } else {
        setMyPlayerId(null);
      }
    });

    socket.on('private-data', (data: PrivatePlayerData) => {
      setMyPrivateData(data);
    });

    socket.on('error', (msg: string) => {
      alert(msg);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Sync state to server
  useEffect(() => {
    if (isRemoteUpdate.current || !socketRef.current) return;
    
    // Avoid emitting state if only the timer changed (to prevent infinite loops and bandwidth waste)
    // The server has its own timer for the authoritative turn skip.
    socketRef.current.emit('update-game-state', { roomId: ROOM_ID, state: gameState });
  }, [gameState]);

  // Win Claim Timer Countdown (Local UI only)
  useEffect(() => {
    if (!gameState.winClaimTimerActive || gameState.status === GameStatus.FINISHED) return;

    const timer = setInterval(() => {
      setGameState(prev => {
        if (!prev.winClaimTimerActive) return prev;
        
        if (prev.winClaimTimeLeft <= 0.1) {
          clearInterval(timer);
          return { ...prev, winClaimTimeLeft: 0 };
        }
        
        // We set isRemoteUpdate to true temporarily to prevent this local change from being emitted
        isRemoteUpdate.current = true;
        const next = { ...prev, winClaimTimeLeft: prev.winClaimTimeLeft - 0.1 };
        setTimeout(() => { isRemoteUpdate.current = false; }, 10);
        return next;
      });
    }, 100);

    return () => clearInterval(timer);
  }, [gameState.winClaimTimerActive, gameState.status]);

  // Persistence
  useEffect(() => {
    const savedScores = localStorage.getItem('binary_battle_scores');
    if (savedScores) {
      const scores = JSON.parse(savedScores);
      setGameState(prev => ({
        ...prev,
        players: prev.players.map((p, i) => ({ ...p, score: scores[i] || 0 }))
      }));
    }
  }, []);

  useEffect(() => {
    if (gameState.status !== GameStatus.SETUP) {
      localStorage.setItem('binary_battle_scores', JSON.stringify(gameState.players.map(p => p.score)));
    }
  }, [gameState.players, gameState.status]);

  const startGame = (mode: GameMode) => {
    setGameState(prev => ({ ...prev, mode, status: GameStatus.SELECTING_PLAYERS }));
  };

  const selectPlayerCount = (count: number) => {
    if (socketRef.current) {
      socketRef.current.emit('start-game', { 
        roomId: ROOM_ID, 
        mode: gameState.mode, 
        numPlayers: count, 
        bits: BOARD_SIZE 
      });
    }
    setMyPrivateData(null);
  };

  const claimSlot = (playerId: number) => {
    if (socketRef.current) {
      socketRef.current.emit('claim-slot', { roomId: ROOM_ID, playerId });
    }
  };

  const toggleCardReveal = (playerId: number) => {
    setRevealedCards(prev => 
      prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]
    );
  };

  const finalizeDistribution = () => {
    setGameState(prev => ({ 
      ...prev, 
      status: GameStatus.PLAYING,
      winClaimTimerActive: false,
      winClaimTimeLeft: 0
    }));
  };

  const drawBit = () => {
    if (gameState.drawnBit !== null) return;
    if (gameState.mode === GameMode.COOPERATIVE && isBoardFull) return;
    setGameState(prev => ({ ...prev, drawnBit: Math.random() > 0.5 ? 1 : 0 }));
  };

  const drawDecimalCard = () => {
    if (socketRef.current && myPlayerId) {
      socketRef.current.emit('draw-decimal-card', { roomId: ROOM_ID, playerId: myPlayerId });
    }
  };

  const handleCellClick = (index: number) => {
    if (gameState.drawnBit === null || gameState.status !== GameStatus.PLAYING || !isMyTurn) return;

    // Mode 2: No overwriting
    if (gameState.mode === GameMode.COOPERATIVE && gameState.board[index].value !== null) {
      setShakeIndex(index);
      setTimeout(() => setShakeIndex(null), 400);
      return;
    }

    if (gameState.mode === GameMode.COMPETITIVE) {
      setGameState(prev => {
        const newBoard = [...prev.board];
        newBoard[index] = { value: prev.drawnBit, ownerId: prev.players[prev.currentPlayerIndex].id };
        
        return {
          ...prev,
          board: newBoard,
          status: GameStatus.PLAYING,
          drawnBit: null,
          winClaimTimerActive: true,
          winClaimTimeLeft: 10
        };
      });
    } else {
      // Mode 2 logic (Cooperative)
      setGameState(prev => {
        const newBoard = [...prev.board];
        newBoard[index] = { value: prev.drawnBit, ownerId: prev.players[prev.currentPlayerIndex].id };
        
        const isBoardFull = newBoard.every(cell => cell.value !== null);
        
        return {
          ...prev,
          board: newBoard,
          drawnBit: null,
          currentPlayerIndex: isBoardFull ? prev.currentPlayerIndex : (prev.currentPlayerIndex + 1) % prev.players.length,
          // Timer doesn't start yet in Cooperative mode when board is full
          winClaimTimerActive: false,
          winClaimTimeLeft: 0
        };
      });
    }
  };

  const resetGame = () => {
    setGameState(prev => ({
      ...prev,
      status: GameStatus.SETUP,
      board: generateBoard(BOARD_SIZE),
      winner: null,
      drawnBit: null,
      winClaimTimerActive: false,
      winClaimTimeLeft: 0
    }));
  };

  const copyRoomLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url);
    alert('Link da sala copiado! Compartilhe com seus amigos para jogarem no mesmo tabuleiro.');
  };

  const isBoardFull = gameState.board.every(cell => cell.value !== null);
  const boardDecimalValue = isBoardFull ? binaryToDecimal(gameState.board.map(c => c.value).join('')) : null;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = myPlayerId === currentPlayer?.id;

  const handleWinClaim = () => {
    setShowWinClaimModal(true);
    setIsWinClaimMinimized(false);
    // Stop the timer when they click "Ganhei"
    setGameState(prev => ({
      ...prev,
      winClaimTimerActive: false,
      winClaimTimeLeft: 0
    }));
  };

  const confirmVictory = () => {
    setShowWinClaimModal(false);
    setGameState(prev => {
      const player = prev.players[prev.currentPlayerIndex];
      const updatedPlayers = prev.players.map(p => p.id === player.id ? { ...p, score: p.score + 1 } : p);
      return {
        ...prev,
        status: GameStatus.FINISHED,
        winner: player,
        players: updatedPlayers,
        winClaimTimerActive: false,
        winClaimTimeLeft: 0,
        targetDecimalMode2: myPrivateData?.targetDecimal
      };
    });
    setMyPrivateData(null);
  };

  const closeWinClaimModal = () => {
    setShowWinClaimModal(false);
    if (socketRef.current) {
      socketRef.current.emit('skip-turn', { roomId: ROOM_ID });
    }
    if (gameState.mode === GameMode.COOPERATIVE) {
      setMyPrivateData(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 space-y-8">
      {/* Header */}
      <div className="text-center space-y-2 relative">
        <h1 className="text-5xl font-black tracking-tighter uppercase italic flex items-center justify-center gap-3">
          <Hash className="text-emerald-500" size={40} />
          Binary Battle
        </h1>
        <p className="text-white/40 font-mono text-sm uppercase tracking-widest">Conquiste o Tabuleiro Bit a Bit</p>
        
        <button 
          onClick={copyRoomLink}
          className="absolute -right-12 top-0 p-2 text-white/20 hover:text-emerald-500 transition-colors"
          title="Compartilhar Sala"
        >
          <Share2 size={20} />
        </button>
      </div>

      <AnimatePresence mode="wait">
        {gameState.status === GameStatus.SETUP ? (
          <motion.div 
            key="setup"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="glass-panel p-8 max-w-2xl w-full space-y-8"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <button 
                onClick={() => startGame(GameMode.COMPETITIVE)}
                className="group relative p-6 bg-white/5 border border-white/10 rounded-2xl text-left transition-all hover:bg-white/10 hover:border-emerald-500/50"
              >
                <div className="mb-4 p-3 bg-emerald-500/20 rounded-xl w-fit text-emerald-400">
                  <Users size={24} />
                </div>
                <h3 className="text-xl font-bold mb-2">Modo Competitivo</h3>
                <p className="text-sm text-white/50">Dispute cada bit. Sobrescreva o oponente para completar seu número secreto primeiro.</p>
                <ChevronRight className="absolute bottom-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => startGame(GameMode.COOPERATIVE)}
                className="group relative p-6 bg-white/5 border border-white/10 rounded-2xl text-left transition-all hover:bg-white/10 hover:border-blue-500/50"
              >
                <div className="mb-4 p-3 bg-blue-500/20 rounded-xl w-fit text-blue-400">
                  <Cpu size={24} />
                </div>
                <h3 className="text-xl font-bold mb-2">Sorte Coletiva</h3>
                <p className="text-sm text-white/50">Trabalhem juntos para preencher o tabuleiro e torçam para que o decimal sorteado coincida.</p>
                <ChevronRight className="absolute bottom-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>

            <div className="pt-6 border-top border-white/5 flex justify-between items-center">
              <div className="flex gap-8">
                {gameState.players.map(p => (
                  <div key={p.id} className="space-y-1">
                    <p className="text-[10px] uppercase font-mono text-white/40">{p.name}</p>
                    <p className="text-xl font-bold font-mono">{p.score} <span className="text-xs font-normal text-white/30">VITÓRIAS</span></p>
                  </div>
                ))}
              </div>
              <div className="text-right">
                <Info size={16} className="text-white/20 ml-auto mb-1" />
                <p className="text-[10px] uppercase font-mono text-white/40">Versão 1.0.4</p>
              </div>
            </div>
          </motion.div>
        ) : gameState.status === GameStatus.SELECTING_PLAYERS ? (
          <motion.div 
            key="selecting"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="glass-panel p-12 max-w-md w-full text-center space-y-8"
          >
            <div className="space-y-2">
              <h2 className="text-3xl font-bold uppercase tracking-tighter italic">Quantos Jogadores?</h2>
              <p className="text-white/40 font-mono text-xs uppercase">Selecione o número de participantes para a batalha</p>
            </div>
            
            <div className="grid grid-cols-3 gap-4">
              {[2, 3, 4].map(num => (
                <button
                  key={num}
                  onClick={() => selectPlayerCount(num)}
                  className="hardware-button py-8 text-2xl font-bold hover:border-emerald-500/50 hover:text-emerald-400"
                >
                  {num}
                </button>
              ))}
            </div>

            <button onClick={resetGame} className="text-white/30 hover:text-white text-xs uppercase font-mono tracking-widest">
              Voltar ao Menu
            </button>
          </motion.div>
        ) : (
          <motion.div 
            key="game"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="w-full max-w-5xl space-y-8"
          >
            {/* Player Slot Selection */}
            <div className="flex flex-wrap justify-center gap-4 mb-4">
              {gameState.players.map((p) => {
                const isOccupied = slotAssignments.some(([id]) => id === p.id);
                const isMe = myPlayerId === p.id;
                
                return (
                  <button
                    key={p.id}
                    disabled={isOccupied && !isMe}
                    onClick={() => claimSlot(p.id)}
                    className={`px-4 py-2 rounded-xl border flex items-center gap-2 transition-all ${
                      isMe 
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400' 
                        : isOccupied 
                          ? 'bg-white/5 border-white/10 text-white/20 cursor-not-allowed'
                          : 'bg-white/5 border-white/10 text-white/60 hover:border-white/30'
                    }`}
                  >
                    {isMe ? <UserCheck size={16} /> : isOccupied ? <Lock size={16} /> : <Users size={16} />}
                    <span className="font-mono text-xs uppercase font-bold">{p.name}</span>
                    {isMe && <span className="text-[10px] ml-1 opacity-60">(VOCÊ)</span>}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
              {/* Left Column: Player Info */}
              <div className="space-y-6">
                <div className="glass-panel p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-mono uppercase text-white/40 tracking-widest">Sua Carta</h3>
                    <Info size={14} className="text-white/20" />
                  </div>
                  
                  {myPlayerId ? (
                    myPrivateData ? (
                      <div className="space-y-4">
                        <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                          <p className="text-[10px] uppercase font-mono text-white/40 mb-1">Decimal Alvo</p>
                          <p className="text-4xl font-black italic text-emerald-400">{myPrivateData.targetDecimal}</p>
                        </div>
                        <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                          <p className="text-[10px] uppercase font-mono text-white/40 mb-1">Binário Alvo</p>
                          <p className="text-2xl font-mono font-bold tracking-widest text-white/80">{myPrivateData.targetBinary}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="p-8 text-center border-2 border-dashed border-white/10 rounded-xl">
                        <p className="text-xs text-white/30 uppercase font-mono">Aguardando início do jogo...</p>
                      </div>
                    )
                  ) : (
                    <div className="p-8 text-center border-2 border-dashed border-amber-500/20 rounded-xl bg-amber-500/5">
                      <p className="text-xs text-amber-500/60 uppercase font-mono font-bold">Selecione um jogador acima para ver sua carta!</p>
                    </div>
                  )}
                </div>

                <div className="glass-panel p-6 space-y-4">
                  <h3 className="text-xs font-mono uppercase text-white/40 tracking-widest">Placar</h3>
                  <div className="space-y-2">
                    {gameState.players.map((p, i) => (
                      <div key={p.id} className={`flex items-center justify-between p-3 rounded-lg ${i === gameState.currentPlayerIndex ? 'bg-white/10 ring-1 ring-white/20' : 'bg-white/5'}`}>
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${
                            i === 0 ? 'bg-emerald-400' : i === 1 ? 'bg-blue-400' : i === 2 ? 'bg-amber-400' : 'bg-purple-400'
                          }`} />
                          <span className={`text-sm font-bold ${i === gameState.currentPlayerIndex ? 'text-white' : 'text-white/60'}`}>
                            {p.name} {slotAssignments.find(([id]) => id === p.id)?.[1] === socketRef.current?.id && '(Você)'}
                          </span>
                        </div>
                        <span className="font-mono font-bold text-white">{p.score}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <button onClick={resetGame} className="hardware-button w-full py-3 flex items-center justify-center gap-2 text-xs uppercase font-mono text-white/40 hover:text-white">
                  <RotateCcw size={14} /> Sair da Partida
                </button>
              </div>

              {/* Middle/Right Column: Board & Controls */}
              <div className="lg:col-span-2 space-y-6">
                {/* Game Info Bar */}
                <div className="flex items-center justify-between glass-panel px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div className={`w-3 h-3 rounded-full animate-pulse ${
                      gameState.currentPlayerIndex === 0 ? 'bg-emerald-500' : 
                      gameState.currentPlayerIndex === 1 ? 'bg-blue-500' : 
                      gameState.currentPlayerIndex === 2 ? 'bg-amber-500' : 'bg-purple-500'
                    }`} />
                    <div>
                      <p className="text-[10px] uppercase font-mono text-white/40">Vez de</p>
                      <p className="font-bold uppercase tracking-tight">
                        {currentPlayer?.name}
                        {isMyTurn && <span className="text-xs normal-case font-normal ml-2 text-emerald-400">(Sua Vez!)</span>}
                      </p>
                    </div>
                  </div>

                  <div className="text-right">
                    <p className="text-[10px] uppercase font-mono text-white/40">Bit Sorteado</p>
                    <AnimatePresence mode="wait">
                      <motion.div 
                        key={gameState.drawnBit}
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className={`text-4xl font-mono font-black ${gameState.drawnBit === null ? 'text-white/10' : 'text-emerald-400'}`}
                      >
                        {gameState.drawnBit ?? '?'}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>

                {/* Board */}
                <div className="space-y-4">
                  {gameState.mode === GameMode.COOPERATIVE && isBoardFull && (
                    <div className="flex items-center justify-center gap-4 p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl">
                      <div className="text-center">
                        <p className="text-[10px] uppercase font-mono text-white/40">Valor do Tabuleiro</p>
                        <p className="text-3xl font-black italic text-emerald-400">{boardDecimalValue}</p>
                      </div>
                      <div className="h-8 w-px bg-white/10" />
                      <div className="text-center">
                        <p className="text-[10px] uppercase font-mono text-white/40">Binário</p>
                        <p className="text-xl font-mono font-bold text-white/60 tracking-widest">
                          {gameState.board.map(c => c.value).join('')}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
                    {gameState.board.map((cell, i) => (
                      <motion.button
                        key={i}
                        whileHover={isMyTurn && gameState.drawnBit !== null ? { y: -5 } : {}}
                        whileTap={isMyTurn && gameState.drawnBit !== null ? { scale: 0.95 } : {}}
                        onClick={() => handleCellClick(i)}
                        disabled={!isMyTurn || gameState.drawnBit === null}
                        className={`aspect-square rounded-2xl border-2 flex items-center justify-center text-3xl font-mono font-black transition-all relative overflow-hidden group ${
                          cell.value !== null 
                            ? cell.ownerId === 1 ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 
                              cell.ownerId === 2 ? 'bg-blue-500/20 border-blue-500/50 text-blue-400' : 
                              cell.ownerId === 3 ? 'bg-amber-500/20 border-amber-500/50 text-amber-400' : 
                              cell.ownerId === 4 ? 'bg-purple-500/10 border-purple-500/30 text-purple-400' :
                              'bg-white/5 border-white/10 text-white/20'
                            : 'bg-white/5 border-white/10 text-white/5 hover:border-white/20'
                        } ${!isMyTurn && 'cursor-not-allowed opacity-80'}`}
                      >
                        <span className="absolute top-1 left-2 text-[10px] font-mono opacity-30">{i}</span>
                        {cell.value ?? ''}
                      </motion.button>
                    ))}
                  </div>
                </div>

                {/* Controls */}
                <div className="space-y-4">
                  {gameState.lastDraw && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={JSON.stringify(gameState.lastDraw)}
                      className={`p-3 rounded-xl border text-center font-mono text-xs uppercase ${
                        gameState.lastDraw.match ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
                      }`}
                    >
                      Último Sorteio: Jogador {gameState.lastDraw.playerId} tirou {gameState.lastDraw.value} 
                      {gameState.lastDraw.match ? ' (ACERTOU!)' : ' (ERROU)'}
                    </motion.div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-4">
                    {gameState.mode === GameMode.COOPERATIVE ? (
                      isBoardFull ? (
                        <button 
                          disabled={!isMyTurn || gameState.status === GameStatus.FINISHED}
                          onClick={drawDecimalCard}
                          className="hardware-button flex-1 py-6 px-12 text-lg bg-blue-500 text-white hover:bg-blue-400 border-none flex items-center justify-center gap-3 disabled:opacity-50"
                        >
                          <RotateCcw size={20} /> Tirar Decimal Aleatório
                        </button>
                      ) : (
                        <button 
                          disabled={!isMyTurn || gameState.drawnBit !== null || gameState.status === GameStatus.FINISHED}
                          onClick={drawBit}
                          className="hardware-button flex-1 py-6 px-12 text-lg bg-emerald-500 text-black hover:bg-emerald-400 border-none flex items-center justify-center gap-3 disabled:opacity-50"
                        >
                          <Play size={20} fill="currentColor" /> Sortear Bit
                        </button>
                      )
                    ) : (
                      <>
                        <button 
                          disabled={!isMyTurn || gameState.drawnBit !== null || gameState.status === GameStatus.FINISHED || gameState.winClaimTimerActive}
                          onClick={drawBit}
                          className="hardware-button flex-1 py-6 px-12 text-lg bg-emerald-500 text-black hover:bg-emerald-400 border-none flex items-center justify-center gap-3 disabled:opacity-50"
                        >
                          <Play size={20} fill="currentColor" /> Sortear Bit
                        </button>

                        <button 
                          disabled={!isMyTurn || !gameState.winClaimTimerActive || gameState.status === GameStatus.FINISHED}
                          onClick={handleWinClaim}
                          className="hardware-button flex-1 py-6 px-12 text-lg bg-amber-500 text-black hover:bg-amber-400 border-none flex items-center justify-center gap-3 disabled:bg-white/5 disabled:text-white/20 relative overflow-hidden"
                        >
                          <Trophy size={20} /> Ganhei
                          {gameState.winClaimTimerActive && (
                            <motion.div 
                              className="absolute bottom-0 left-0 h-1 bg-black/30"
                              initial={{ width: "100%" }}
                              animate={{ width: `${(gameState.winClaimTimeLeft / 10) * 100}%` }}
                              transition={{ duration: 0.1, ease: "linear" }}
                            />
                          )}
                        </button>
                      </>
                    )}
                  </div>
                  <p className="text-center text-[10px] font-mono text-white/30 uppercase">
                    {!myPlayerId ? "Selecione um jogador acima para começar" :
                     !isMyTurn ? `Aguarde a vez de ${currentPlayer?.name}` :
                     gameState.mode === GameMode.COOPERATIVE 
                      ? (!isBoardFull 
                        ? "Sua vez! Sorteie um bit e escolha uma casa." 
                        : "Tabuleiro completo! Sorteie um decimal para tentar ganhar.")
                      : (gameState.winClaimTimerActive 
                        ? `Você tem ${gameState.winClaimTimeLeft.toFixed(1)}s para clicar em 'Ganhei'!`
                        : "Sua vez! Sorteie um bit e escolha uma casa.")}
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Finished Modal */}
      <AnimatePresence>
        {gameState.status === GameStatus.FINISHED && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="glass-panel max-w-lg w-full p-12 text-center space-y-8 border-emerald-500/30"
            >
              <div className="flex justify-center">
                <div className="p-6 bg-emerald-500/20 rounded-full text-emerald-400">
                  <Trophy size={64} />
                </div>
              </div>
              
              <div className="space-y-2">
                <h2 className="text-4xl font-black uppercase tracking-tighter italic">
                  {gameState.winner ? 'Vitória!' : 'Fim de Jogo'}
                </h2>
                <p className="text-white/60 font-mono">
                  {gameState.winner 
                    ? `${gameState.winner.name} dominou os bits!` 
                    : gameState.mode === GameMode.COOPERATIVE 
                      ? 'O decimal sorteado não coincidiu.' 
                      : 'Empate técnico!'}
                </p>
              </div>

              {gameState.mode === GameMode.COOPERATIVE && (
                <div className="grid grid-cols-2 gap-4 p-4 bg-white/5 rounded-xl border border-white/10">
                  <div>
                    <p className="text-[10px] uppercase font-mono text-white/40">Formado</p>
                    <p className="text-2xl font-mono font-bold">
                      {binaryToDecimal(gameState.board.map(c => c.value).join(''))}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase font-mono text-white/40">Sorteado</p>
                    <p className="text-2xl font-mono font-bold text-emerald-400">
                      {gameState.targetDecimalMode2}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3">
                <button onClick={() => startGame(gameState.mode)} className="hardware-button bg-emerald-500 text-black border-none hover:bg-emerald-400">
                  Jogar Novamente
                </button>
                <button onClick={resetGame} className="hardware-button">
                  Menu Principal
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Win Claim Informative Modal */}
      <AnimatePresence>
        {showWinClaimModal && (
          <div className="fixed inset-0 z-50 flex items-end justify-start p-6 pointer-events-none">
            {isWinClaimMinimized ? (
              <motion.button
                initial={{ x: -50, opacity: 0, scale: 0.8 }}
                animate={{ x: 0, opacity: 1, scale: 1 }}
                exit={{ x: -50, opacity: 0, scale: 0.8 }}
                onClick={() => setIsWinClaimMinimized(false)}
                className="glass-panel p-4 text-amber-400 pointer-events-auto hover:bg-white/10 transition-colors shadow-2xl flex items-center gap-3 border-amber-500/30"
              >
                <Trophy size={24} />
                <span className="text-[10px] font-mono uppercase font-bold tracking-widest">Reivindicação</span>
              </motion.button>
            ) : (
              <motion.div 
                initial={{ y: 50, opacity: 0, scale: 0.9 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: 50, opacity: 0, scale: 0.9 }}
                className="glass-panel max-w-sm w-full p-8 text-center space-y-6 border-amber-500/30 pointer-events-auto shadow-2xl shadow-amber-500/10 relative"
              >
                <button 
                  onClick={() => setIsWinClaimMinimized(true)}
                  className="absolute top-4 right-4 text-white/20 hover:text-white transition-colors"
                  title="Minimizar"
                >
                  <ChevronRight size={18} className="rotate-90" />
                </button>

                <div className="flex justify-center">
                  <div className="p-3 bg-amber-500/20 rounded-full text-amber-400">
                    <Trophy size={32} />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <h2 className="text-xl font-black uppercase tracking-tighter italic">Reivindicação de Vitória</h2>
                  <p className="text-xs text-white/70 leading-relaxed">
                    Você acredita que venceu! Agora, você deve confirmar seu número binário com seus amigos para validar se realmente completou seu objetivo.
                  </p>
                </div>

                <div className="p-3 bg-white/5 rounded-xl border border-white/10 text-left space-y-1">
                  <p className="text-[9px] uppercase font-mono text-white/40">Seu Alvo</p>
                  <p className="text-lg font-mono font-bold text-emerald-400">
                    {myPrivateData?.targetDecimal}
                    <span className="text-xs font-normal text-white/30 ml-2">({myPrivateData?.targetBinary})</span>
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <button 
                    onClick={confirmVictory}
                    className="hardware-button w-full py-3 bg-emerald-500 text-black border-none hover:bg-emerald-400 text-sm"
                  >
                    Confirmar Vitória
                  </button>
                  <button 
                    onClick={closeWinClaimModal}
                    className="w-full py-2 text-[10px] uppercase font-mono text-white/40 hover:text-white transition-colors"
                  >
                    Não venci ainda (Passar Vez)
                  </button>
                </div>
              </motion.div>
            )}
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
