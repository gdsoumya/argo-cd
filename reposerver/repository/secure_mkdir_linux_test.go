//go:build linux

package repository

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSecureMkdirAllLinux(t *testing.T) {
	root := t.TempDir()

	unsafePath := "test/dir"
	fullPath, err := SecureMkdirAll(root, unsafePath, os.ModePerm)
	require.NoError(t, err)

	expectedPath := filepath.Join(root, unsafePath)
	require.Equal(t, expectedPath, fullPath)
}

func TestSecureMkdirAllWithExistingDir(t *testing.T) {
	root := t.TempDir()
	unsafePath := "existing/dir"

	fullPath, err := SecureMkdirAll(root, unsafePath, os.ModePerm)
	require.NoError(t, err)

	newPath, err := SecureMkdirAll(root, unsafePath, os.ModePerm)
	require.NoError(t, err)
	assert.Equal(t, fullPath, newPath)
}

func TestSecureMkdirAllWithFile(t *testing.T) {
	root := t.TempDir()
	unsafePath := "file.txt"

	filePath := filepath.Join(root, unsafePath)
	err := os.WriteFile(filePath, []byte("test"), os.ModePerm)
	require.NoError(t, err)

	_, err = SecureMkdirAll(root, unsafePath, os.ModePerm)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to make directory")
}

func TestSecureMkdirAllDotDotPath(t *testing.T) {
	root := t.TempDir()
	unsafePath := "../outside"

	fullPath, err := SecureMkdirAll(root, unsafePath, os.ModePerm)
	require.NoError(t, err)

	expectedPath := filepath.Join(root, "outside")
	assert.Equal(t, expectedPath, fullPath)

	info, err := os.Stat(fullPath)
	require.NoError(t, err)
	assert.True(t, info.IsDir())

	relPath, err := filepath.Rel(root, fullPath)
	require.NoError(t, err)
	assert.False(t, strings.HasPrefix(relPath, ".."))
}
