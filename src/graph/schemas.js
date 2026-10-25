import * as z from 'zod';

export const VEREDITOS = ['VERDADEIRO', 'FALSO', 'IMPRECISO', 'SEM_EVIDENCIA'];

export const ExtractionSchema = z.object({
  afirmacoes: z.array(z.object({
    texto: z.string().describe('Afirmação autocontida, fiel ao que foi dito (não corrija o número dito)'),
    trecho_original: z.string().describe('Trecho literal da transcrição'),
    categoria: z.enum(['estatistica', 'economia', 'saude', 'seguranca', 'educacao', 'meio_ambiente', 'historia', 'legislacao', 'citacao', 'ciencia', 'outro']),
  })).describe('No máximo 3 afirmações factuais checáveis; lista vazia se não houver'),
});

export const PlanSchema = z.object({
  consultas: z.array(z.string()).describe('1 a 3 consultas de busca curtas e específicas, em português'),
});

export const VerdictSchema = z.object({
  veredito: z.enum(VEREDITOS),
  confianca: z.number().describe('0 a 100'),
  resumo: z.string().describe('Uma frase curta para exibir em destaque'),
  explicacao: z.string().describe('2 a 4 frases explicando o veredito com base nas evidências'),
  dado_correto: z.string().describe('O que os dados dizem (número, período, órgão). Vazio se não se aplica.'),
  evidencias_usadas: z.array(z.string()).describe('IDs das evidências que sustentam o veredito, ex.: ["E1","E3"]'),
  precisa_mais_busca: z.boolean().describe('true se as evidências são insuficientes e outra busca pode resolver'),
  lacuna: z.string().describe('O que falta descobrir (vazio se nada)'),
});
