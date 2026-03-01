export const decimalToBinary = (dec: number, bits: number): string => 
  dec.toString(2).padStart(bits, '0');

export const binaryToDecimal = (bin: string): number => 
  parseInt(bin, 2);

export const checkBitCorrectness = (bit: number, position: number, targetDecimal: number, totalBits: number): boolean => {
  const targetBinary = decimalToBinary(targetDecimal, totalBits);
  // Binary strings are 0-indexed from left (MSB) to right (LSB)
  return targetBinary[position] === bit.toString();
};

export const getRandomInt = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const generateBoard = (size: number): { value: null, ownerId: null }[] => {
  return Array(size).fill(null).map(() => ({ value: null, ownerId: null }));
};
