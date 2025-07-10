package repository

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-cd/v3/reposerver/apiclient"
)

func TestWriteForPaths(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		paths       []*apiclient.FileDetails
		expectedErr string
	}{
		{
			name: "write single file",
			paths: []*apiclient.FileDetails{
				{
					Path: "test.yaml",
					Data: []byte("apiVersion: v1\nkind: Pod\n"),
				},
			},
		},
		{
			name: "write multiple files",
			paths: []*apiclient.FileDetails{
				{
					Path: "deployment.yaml",
					Data: []byte("apiVersion: apps/v1\nkind: Deployment\n"),
				},
				{
					Path: "service.yaml",
					Data: []byte("apiVersion: v1\nkind: Service\n"),
				},
			},
		},
		{
			name: "write file in nested directory",
			paths: []*apiclient.FileDetails{
				{
					Path: "manifests/app/deployment.yaml",
					Data: []byte("apiVersion: apps/v1\nkind: Deployment\n"),
				},
			},
		},
		{
			name: "write file with dot path",
			paths: []*apiclient.FileDetails{
				{
					Path: ".",
					Data: []byte("content"),
				},
			},
			expectedErr: "file is required",
		},
		{
			name: "write file with empty path",
			paths: []*apiclient.FileDetails{
				{
					Path: "subdir/",
					Data: []byte("content"),
				},
			},
			expectedErr: "file is required",
		},
		{
			name: "write empty file",
			paths: []*apiclient.FileDetails{
				{
					Path: "empty.txt",
					Data: []byte(""),
				},
			},
		},
		{
			name: "write binary file",
			paths: []*apiclient.FileDetails{
				{
					Path: "binary.bin",
					Data: []byte{0x00, 0x01, 0x02, 0xFF},
				},
			},
		},
		{
			name: "overwrite existing file",
			paths: []*apiclient.FileDetails{
				{
					Path: "existing.txt",
					Data: []byte("original content"),
				},
				{
					Path: "existing.txt",
					Data: []byte("new content"),
				},
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// Create temporary directory
			tempDir, err := os.MkdirTemp("", "write-for-paths-test-*")
			require.NoError(t, err)
			defer os.RemoveAll(tempDir)

			// Execute the function
			err = WriteForPaths(tempDir, tt.paths)

			// Check error expectations
			if tt.expectedErr != "" {
				require.Error(t, err)
				require.Contains(t, err.Error(), tt.expectedErr)
				return
			}

			require.NoError(t, err)

			// Verify files were written correctly
			// For overwrite test, only check the final state
			if tt.name == "overwrite existing file" {
				expectedPath := filepath.Join(tempDir, "existing.txt")
				require.FileExists(t, expectedPath, "File should exist: existing.txt")

				actualContent, err := os.ReadFile(expectedPath)
				require.NoError(t, err, "Should be able to read file: existing.txt")
				require.Equal(t, []byte("new content"), actualContent, "File should contain the last written content")
			} else {
				for _, path := range tt.paths {
					if path.Path == "." {
						continue // Skip dot path validation
					}

					expectedPath := filepath.Join(tempDir, path.Path)

					// Check file exists
					require.FileExists(t, expectedPath, "File should exist: %s", path.Path)

					// Check file content
					actualContent, err := os.ReadFile(expectedPath)
					require.NoError(t, err, "Should be able to read file: %s", path.Path)
					require.Equal(t, path.Data, actualContent, "File content should match for: %s", path.Path)

					// Check file permissions (use a more flexible check due to umask)
					fileInfo, err := os.Stat(expectedPath)
					require.NoError(t, err)
					// Just check that it's a regular file with some reasonable permissions
					require.True(t, fileInfo.Mode().IsRegular(), "Should be a regular file")
					require.GreaterOrEqual(t, fileInfo.Mode().Perm(), 0o644, "File should have at least read/write permissions")
				}
			}
		})
	}
}

func TestDeletePaths(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		setupFiles  map[string][]byte // files to create before deletion
		setupDirs   []string          // directories to create before deletion
		deletePaths []string          // paths to delete
		expectedErr string
	}{
		{
			name: "delete single file",
			setupFiles: map[string][]byte{
				"test.yaml": []byte("content"),
			},
			deletePaths: []string{"test.yaml"},
		},
		{
			name: "delete multiple files",
			setupFiles: map[string][]byte{
				"file1.yaml": []byte("content1"),
				"file2.yaml": []byte("content2"),
			},
			deletePaths: []string{"file1.yaml", "file2.yaml"},
		},
		{
			name: "delete directory with files",
			setupFiles: map[string][]byte{
				"dir/file1.txt": []byte("content1"),
				"dir/file2.txt": []byte("content2"),
			},
			deletePaths: []string{"dir"},
		},
		{
			name: "delete nested directories",
			setupFiles: map[string][]byte{
				"parent/child/grandchild/file.txt": []byte("content"),
			},
			deletePaths: []string{"parent"},
		},
		{
			name: "delete non-existent file",
			setupFiles: map[string][]byte{
				"existing.txt": []byte("content"),
			},
			deletePaths: []string{"non-existent.txt"},
		},
		{
			name:        "delete non-existent directory",
			setupDirs:   []string{"existing-dir"},
			deletePaths: []string{"non-existent-dir"},
		},
		{
			name:        "delete empty path",
			deletePaths: []string{""},
			expectedErr: "path is required",
		},
		{
			name:        "delete root path",
			deletePaths: []string{"."},
			expectedErr: "path is required",
		},
		{
			name: "delete file in nested directory",
			setupFiles: map[string][]byte{
				"manifests/app/deployment.yaml": []byte("content"),
				"manifests/app/service.yaml":    []byte("content"),
			},
			deletePaths: []string{"manifests/app/deployment.yaml"},
		},
		{
			name: "delete mixed files and directories",
			setupFiles: map[string][]byte{
				"file.txt":          []byte("content"),
				"dir1/subfile.txt":  []byte("content"),
				"dir2/subfile2.txt": []byte("content"),
			},
			deletePaths: []string{"file.txt", "dir1", "dir2"},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// Create temporary directory
			tempDir, err := os.MkdirTemp("", "delete-paths-test-*")
			require.NoError(t, err)
			defer os.RemoveAll(tempDir)

			// Setup files
			for filePath, content := range tt.setupFiles {
				fullPath := filepath.Join(tempDir, filePath)
				dir := filepath.Dir(fullPath)

				err := os.MkdirAll(dir, os.ModePerm)
				require.NoError(t, err)

				err = os.WriteFile(fullPath, content, os.ModePerm)
				require.NoError(t, err)
			}

			// Setup directories
			for _, dirPath := range tt.setupDirs {
				fullPath := filepath.Join(tempDir, dirPath)
				err := os.MkdirAll(fullPath, os.ModePerm)
				require.NoError(t, err)
			}

			// Execute the function
			err = DeletePaths(tempDir, tt.deletePaths)

			// Check error expectations
			if tt.expectedErr != "" {
				require.Error(t, err)
				require.Contains(t, err.Error(), tt.expectedErr)
				return
			}

			require.NoError(t, err)

			// Verify deletions
			for _, deletePath := range tt.deletePaths {
				if deletePath == "" || deletePath == "." {
					continue // Skip validation for error cases
				}

				fullPath := filepath.Join(tempDir, deletePath)
				_, err := os.Stat(fullPath)
				require.True(t, os.IsNotExist(err), "Path should not exist after deletion: %s", deletePath)
			}

			// Verify remaining files for specific test cases
			if tt.name == "delete file in nested directory" {
				// service.yaml should still exist
				servicePath := filepath.Join(tempDir, "manifests/app/service.yaml")
				require.FileExists(t, servicePath, "service.yaml should still exist")

				// deployment.yaml should be deleted
				deploymentPath := filepath.Join(tempDir, "manifests/app/deployment.yaml")
				_, err := os.Stat(deploymentPath)
				require.True(t, os.IsNotExist(err), "deployment.yaml should be deleted")
			}
		})
	}
}
