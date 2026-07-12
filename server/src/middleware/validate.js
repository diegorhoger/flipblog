import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(200),
});

export const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'username must be at least 3 characters')
    .max(120)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'username may only contain letters, numbers, dot, underscore or hyphen'),
  password: z.string().min(8, 'password must be at least 8 characters').max(200),
  role: z.enum(['admin', 'author']).optional().default('author'),
});

export const postSchema = z.object({
  title: z.string().min(1, 'title is required').max(200),
  author: z.string().max(120).optional().default(''),
  excerpt: z.string().max(280).optional(),
  cover_image: z.string().max(500).nullable().optional(),
  content: z.string().max(200_000).optional().default(''),
  status: z.enum(['draft', 'published']).optional(),
  slug: z.string().max(120).optional(),
});

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'validation_failed',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.valid = result.data;
    next();
  };
}
