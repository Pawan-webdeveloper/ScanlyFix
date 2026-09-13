/**
 * Header encryption utility tests.
 *
 * Tests the AES-256-GCM encryption/decryption for custom headers.
 * Tests masking of values for API responses.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  encryptValue,
  decryptValue,
  maskValue,
  maskHeader,
  maskHeaders,
  prepareHeaders,
} from '../lib/header-encryption.ts'

// Generate a test encryption key (32 bytes hex)
const TEST_KEY = 'a'.repeat(64)

describe('header-encryption', () => {
  beforeEach(() => {
    // Set test encryption key
    process.env.HEADER_ENCRYPTION_KEY = TEST_KEY
  })

  describe('encryptValue / decryptValue', () => {
    it('encrypts and decrypts a value', () => {
      const plaintext = 'Bearer abc123xyz'
      const encrypted = encryptValue(plaintext)
      const decrypted = decryptValue(encrypted)

      expect(decrypted).toBe(plaintext)
    })

    it('produces different ciphertext for same plaintext (random IV)', () => {
      const plaintext = 'test-value'
      const encrypted1 = encryptValue(plaintext)
      const encrypted2 = encryptValue(plaintext)

      // Different ciphertexts due to random IV
      expect(encrypted1).not.toBe(encrypted2)

      // But both decrypt to same plaintext
      expect(decryptValue(encrypted1)).toBe(plaintext)
      expect(decryptValue(encrypted2)).toBe(plaintext)
    })

    it('returns format IV:TAG:CIPHERTEXT', () => {
      const encrypted = encryptValue('test')
      const parts = encrypted.split(':')

      expect(parts).toHaveLength(3)
      // Each part should be valid base64
      parts.forEach((part) => {
        expect(() => Buffer.from(part, 'base64')).not.toThrow()
      })
    })

    it('decrypts with wrong key fails', () => {
      const plaintext = 'secret'
      const encrypted = encryptValue(plaintext)

      // Change key
      process.env.HEADER_ENCRYPTION_KEY = 'b'.repeat(64)

      expect(() => decryptValue(encrypted)).toThrow()
    })
  })

  describe('maskValue', () => {
    it('masks value showing last 4 chars', () => {
      const masked = maskValue('Bearer abc123xyz')
      // Shows last 4 chars: '3xyz'
      expect(masked).toBe('***3xyz')
    })

    it('masks short value completely', () => {
      const masked = maskValue('abc')
      expect(masked).toBe('****')
    })

    it('masks empty value', () => {
      const masked = maskValue('')
      expect(masked).toBe('****')
    })

    it('masks value with exactly 4 chars', () => {
      const masked = maskValue('test')
      expect(masked).toBe('****')
    })

    it('masks value with 5 chars', () => {
      const masked = maskValue('abcde')
      // Shows last 4 chars: 'bcde'
      expect(masked).toBe('***bcde')
    })
  })

  describe('maskHeader', () => {
    it('masks a custom header', () => {
      const encrypted = encryptValue('Bearer token123')
      const masked = maskHeader({
        key: 'Authorization',
        valueEncrypted: encrypted,
      })

      expect(masked.key).toBe('Authorization')
      // Shows last 4 chars: 'n123'
      expect(masked.valueMasked).toBe('***n123')
    })

    it('handles invalid encrypted value', () => {
      const masked = maskHeader({
        key: 'Authorization',
        valueEncrypted: 'invalid',
      })

      expect(masked.key).toBe('Authorization')
      expect(masked.valueMasked).toBe('***invalid')
    })
  })

  describe('maskHeaders', () => {
    it('masks multiple headers', () => {
      const headers = [
        { key: 'Authorization', valueEncrypted: encryptValue('Bearer token1') },
        { key: 'X-API-Key', valueEncrypted: encryptValue('key123') },
      ]

      const masked = maskHeaders(headers)

      expect(masked).toHaveLength(2)
      const first = masked[0]
      const second = masked[1]
      expect(first?.key).toBe('Authorization')
      expect(first?.valueMasked).toBe('***ken1')
      expect(second?.key).toBe('X-API-Key')
      expect(second?.valueMasked).toBe('***y123')
    })

    it('handles empty array', () => {
      const masked = maskHeaders([])
      expect(masked).toHaveLength(0)
    })
  })

  describe('prepareHeaders', () => {
    it('decrypts headers for request', () => {
      const headers = [
        { key: 'Authorization', valueEncrypted: encryptValue('Bearer token123') },
        { key: 'X-Custom', valueEncrypted: encryptValue('custom-value') },
      ]

      const decrypted = prepareHeaders(headers)

      expect(decrypted).toEqual({
        Authorization: 'Bearer token123',
        'X-Custom': 'custom-value',
      })
    })

    it('skips invalid encrypted values', () => {
      const headers = [
        { key: 'Authorization', valueEncrypted: encryptValue('valid') },
        { key: 'Invalid', valueEncrypted: 'invalid' },
      ]

      const decrypted = prepareHeaders(headers)

      expect(decrypted).toEqual({
        Authorization: 'valid',
      })
    })

    it('handles empty array', () => {
      const decrypted = prepareHeaders([])
      expect(decrypted).toEqual({})
    })
  })

  describe('security', () => {
    it('does not expose plaintext in API response', () => {
      const plaintext = 'Bearer super-secret-token-12345'
      const encrypted = encryptValue(plaintext)
      const masked = maskHeader({ key: 'Authorization', valueEncrypted: encrypted })

      // Masked value should not contain full plaintext
      expect(masked.valueMasked).not.toContain(plaintext)
      // Should only show last 4 chars: '2345'
      expect(masked.valueMasked).toBe('***2345')
    })

    it('encrypted value is not plaintext', () => {
      const plaintext = 'my-secret-api-key'
      const encrypted = encryptValue(plaintext)

      // Encrypted value should not contain plaintext
      expect(encrypted).not.toContain(plaintext)
      // Should be in IV:TAG:CIPHERTEXT format
      expect(encrypted.split(':')).toHaveLength(3)
    })

    it('gracefully falls back when HEADER_ENCRYPTION_KEY is unset without crashing', () => {
      delete process.env.HEADER_ENCRYPTION_KEY
      const plaintext = 'token-without-env'
      const encrypted = encryptValue(plaintext)
      expect(encrypted).toBeTruthy()
      expect(decryptValue(encrypted)).toBe(plaintext)
    })
  })
})
