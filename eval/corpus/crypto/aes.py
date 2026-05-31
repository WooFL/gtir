import os
import struct
from typing import Tuple


def pkcs7_pad(data: bytes, block_size: int = 16) -> bytes:
    """Pad data to a multiple of block_size using PKCS#7."""
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len] * pad_len)


def pkcs7_unpad(data: bytes) -> bytes:
    """Strip PKCS#7 padding, raising ValueError if malformed."""
    if not data:
        raise ValueError("empty data")
    pad_len = data[-1]
    if pad_len == 0 or pad_len > 16:
        raise ValueError(f"invalid padding byte: {pad_len}")
    if data[-pad_len:] != bytes([pad_len] * pad_len):
        raise ValueError("padding mismatch")
    return data[:-pad_len]


def aes_cbc_encrypt(key: bytes, plaintext: bytes) -> Tuple[bytes, bytes]:
    """Encrypt with AES-CBC; returns (iv, ciphertext). Key must be 16/24/32 bytes."""
    from Crypto.Cipher import AES
    iv = os.urandom(16)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    return iv, cipher.encrypt(pkcs7_pad(plaintext))


def aes_cbc_decrypt(key: bytes, iv: bytes, ciphertext: bytes) -> bytes:
    """Decrypt AES-CBC ciphertext and strip PKCS#7 padding."""
    from Crypto.Cipher import AES
    cipher = AES.new(key, AES.MODE_CBC, iv)
    return pkcs7_unpad(cipher.decrypt(ciphertext))
