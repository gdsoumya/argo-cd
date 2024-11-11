//go:build !linux

package repository

import (
	"errors"
	"fmt"
	"os"

	securejoin "github.com/cyphar/filepath-securejoin"
)

func SecureMkdirAll(root, unsafePath string, mode os.FileMode) (string, error) {
	fullPath, err := securejoin.SecureJoin(root, unsafePath)
	if err != nil {
		return "", fmt.Errorf("failed to construct secure path: %w", err)
	}
	if _, err := os.Stat(fullPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			err := os.MkdirAll(fullPath, mode)
			if err != nil {
				return "", fmt.Errorf("failed to make directory: %w", err)
			}
		} else {
			return "", fmt.Errorf("failed to stat directory: %w", err)
		}
	}
	return fullPath, nil
}
