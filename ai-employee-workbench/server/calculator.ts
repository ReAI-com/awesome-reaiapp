/** Bounded integer arithmetic for explicit business-tool calls; never evaluates expressions. */
export function calculate(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('calculate 参数必须是对象');
  const { operation, operands } = input as Record<string, unknown>;
  if (operation !== 'sum' && operation !== 'subtract') throw new Error('calculate operation 仅支持 sum 或 subtract');
  if (!Array.isArray(operands) || operands.length < 1 || operands.length > 200) throw new Error('calculate operands 必须包含 1–200 个安全整数');
  for (const value of operands) {
    if (!Number.isSafeInteger(value)) throw new Error('calculate operands 仅接受安全整数；财务金额请以整数分传入');
  }
  if (operation === 'subtract' && operands.length < 2) throw new Error('calculate subtract 至少需要 2 个操作数');
  const values = operands as number[];
  let result = operation === 'sum' ? 0 : values[0];
  for (const value of operation === 'sum' ? values : values.slice(1)) {
    result = operation === 'sum' ? result + value : result - value;
    if (!Number.isSafeInteger(result)) throw new Error('calculate 中间值或结果超出安全整数范围');
  }
  return { operation, operands: [...values], result };
}
