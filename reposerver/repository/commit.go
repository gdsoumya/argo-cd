package repository

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	securejoin "github.com/cyphar/filepath-securejoin"
	log "github.com/sirupsen/logrus"

	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"

	"github.com/argoproj/argo-cd/v3/reposerver/apiclient"
	"github.com/argoproj/argo-cd/v3/reposerver/metrics"
	"github.com/argoproj/argo-cd/v3/util/git"
	"github.com/argoproj/argo-cd/v3/util/io/files"
)

// handleCommitRequest handles the commit request. It clones the repository, checks out the
// target branch, writes the files to the repository, commits the changes, and pushes
// the changes. It returns the output and commit hash of the git commands and an error if one occurred.
func (s *Service) handleCommitRequest(ctx context.Context, logCtx *log.Entry, r *apiclient.CommitFilesRequest) (string, string, error) {
	if r.Repo == nil {
		return "", "", errors.New("repo is required")
	}
	if r.Repo.Repo == "" {
		return "", "", errors.New("repo URL is required")
	}
	if r.TargetBranch == "" {
		return "", "", errors.New("target branch is required")
	}

	logCtx = logCtx.WithField("repo", r.Repo.Repo)
	logCtx.Debug("Initiating git client")
	gitClient, dirPath, cleanup, err := s.initGitClient(ctx, logCtx, gitClientConf{
		Repo:     r.Repo,
		Username: r.Username,
		Email:    r.Email,
	})
	if err != nil {
		return "", "", fmt.Errorf("failed to init git client: %w", err)
	}
	defer cleanup()

	logCtx.Debugf("Checking out target branch %s", r.TargetBranch)
	var out string
	out, err = gitClient.CheckoutOrOrphan(r.TargetBranch, false)
	if err != nil {
		return out, "", fmt.Errorf("failed to checkout sync branch: %w", err)
	}

	logCtx.Debug("Writing files")
	err = WriteForPaths(dirPath, r.Files)
	if err != nil {
		return "", "", fmt.Errorf("failed to write files: %w", err)
	}

	logCtx.Debug("Committing and pushing changes")
	out, err = gitClient.CommitAndPush(r.TargetBranch, r.CommitMessage)
	if err != nil {
		return out, "", fmt.Errorf("failed to commit and push: %w", err)
	}

	logCtx.Debug("Getting commit SHA")
	sha, err := gitClient.CommitSHA()
	if err != nil {
		return "", "", fmt.Errorf("failed to get commit SHA: %w", err)
	}

	return "", sha, nil
}

type gitClientConf struct {
	Repo            *v1alpha1.Repository
	Username, Email string
}

// initGitClient initializes a git client for the given repository and returns the client, the path to the directory where
// the repository is cloned, a cleanup function that should be called when the directory is no longer needed, and an error
// if one occurred.
func (s *Service) initGitClient(_ context.Context, logCtx *log.Entry, r gitClientConf) (git.Client, string, func(), error) {
	dirPath, err := files.CreateTempDir("/tmp/_commit-service")
	if err != nil {
		return nil, "", nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	// Call cleanupOrLog in this function if an error occurs to ensure the temp dir is cleaned up.
	cleanupOrLog := func() {
		err := os.RemoveAll(dirPath)
		if err != nil {
			logCtx.WithError(err).Error("failed to cleanup temp dir")
		}
	}

	gitCreds := r.Repo.GetGitCreds(s.gitCredsStore)
	opts := git.WithEventHandlers(metrics.NewGitClientEventHandlers(s.metricsServer))
	gitClient, err := git.NewClientExt(r.Repo.Repo, dirPath, gitCreds, r.Repo.IsInsecure(), r.Repo.IsLFSEnabled(), r.Repo.Proxy, r.Repo.NoProxy, opts)
	if err != nil {
		cleanupOrLog()
		return nil, "", nil, fmt.Errorf("failed to create git client: %w", err)
	}

	logCtx.Debugf("Initializing repo %s", r.Repo.Repo)
	err = gitClient.Init()
	if err != nil {
		cleanupOrLog()
		return nil, "", nil, fmt.Errorf("failed to init git client: %w", err)
	}

	logCtx.Debugf("Fetching repo %s", r.Repo.Repo)
	err = gitClient.Fetch("")
	if err != nil {
		cleanupOrLog()
		return nil, "", nil, fmt.Errorf("failed to clone repo: %w", err)
	}

	logCtx.Debugf("Getting user info for repo credentials")

	authorName := "Argo CD"
	authorEmail := "argo-cd@example.com"

	if r.Username != "" {
		authorName = r.Username
	}
	if r.Email != "" {
		authorEmail = r.Email
	}

	logCtx.Debugf("Setting author %s <%s>", authorName, authorEmail)
	_, err = gitClient.SetAuthor(authorName, authorEmail)
	if err != nil {
		cleanupOrLog()
		return nil, "", nil, fmt.Errorf("failed to set author: %w", err)
	}

	return gitClient, dirPath, cleanupOrLog, nil
}

// WriteForPaths writes the files to the given paths
func WriteForPaths(rootPath string, paths []*apiclient.FileDetails) error {
	for _, p := range paths {
		if err := writeFile(rootPath, p); err != nil {
			return err
		}
	}
	return nil
}

func writeFile(rootPath string, p *apiclient.FileDetails) error {
	hydratePath := p.Path
	if hydratePath == "." {
		hydratePath = ""
	}

	dir, file := filepath.Split(hydratePath)
	if file == "" {
		return fmt.Errorf("file is required, path: %s", p.Path)
	}

	fullHydratePath, err := SecureMkdirAll(rootPath, dir, os.ModePerm)
	if err != nil {
		return fmt.Errorf("failed to create path: %v %w", p.Path, err)
	}

	filePath, err := securejoin.SecureJoin(fullHydratePath, file)
	if err != nil {
		return fmt.Errorf("failed to create path: %v %w", p.Path, err)
	}

	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.ModePerm)
	if err != nil {
		return fmt.Errorf("failed to open manifest file: %v %w", p.Path, err)
	}
	defer func() {
		err = f.Close()
		if err != nil {
			log.WithError(err).Errorf("failed to close file %v", p.Path)
		}
	}()

	_, err = f.Write(p.Data)
	if err != nil {
		return fmt.Errorf("failed to write manifest file: %v %w", p.Path, err)
	}
	return nil
}

func (s *Service) CommitFiles(ctx context.Context, r *apiclient.CommitFilesRequest) (*apiclient.CommitFilesResponse, error) {
	logCtx := log.WithFields(log.Fields{"branch": r.TargetBranch, "repo": r.Repo.Repo})

	out, sha, err := s.handleCommitRequest(ctx, logCtx, r)
	if err != nil {
		logCtx.WithError(err).WithField("output", out).Error("failed to handle commit request")
		return &apiclient.CommitFilesResponse{}, err
	}

	logCtx.Info("Successfully handled commit request")
	return &apiclient.CommitFilesResponse{
		CommitSha: sha,
	}, nil
}

func DeletePaths(rootPath string, paths []string) error {
	// delete files or dirs on the given path
	for _, p := range paths {
		if p == "" || p == "." {
			return errors.New("path is required, got empty/root path")
		}
		filePath, err := securejoin.SecureJoin(rootPath, p)
		if err != nil {
			return fmt.Errorf("failed to create path: %v %w", p, err)
		}

		err = os.RemoveAll(filePath)
		if err != nil {
			return fmt.Errorf("failed to remove file or directory: %v %w", p, err)
		}
	}
	return nil
}

// handleDeleteRequest handles the delete files/dir request. It clones the repository, checks out the
// target branch, deletes the target files/dirs in the repository, commits the changes, and pushes
// the changes. It returns the output and commit hash of the git command and an error if one occurred.
func (s *Service) handleDeleteRequest(ctx context.Context, logCtx *log.Entry, r *apiclient.DeleteFilesRequest) (string, string, error) {
	if r.Repo == nil {
		return "", "", errors.New("repo is required")
	}
	if r.Repo.Repo == "" {
		return "", "", errors.New("repo URL is required")
	}
	if r.TargetBranch == "" {
		return "", "", errors.New("target branch is required")
	}

	logCtx = logCtx.WithField("repo", r.Repo.Repo)
	logCtx.Debug("Initiating git client")
	gitClient, dirPath, cleanup, err := s.initGitClient(ctx, logCtx, gitClientConf{
		Repo:     r.Repo,
		Username: r.Username,
		Email:    r.Email,
	})
	if err != nil {
		return "", "", fmt.Errorf("failed to init git client: %w", err)
	}
	defer cleanup()

	logCtx.Debugf("Checking out target branch %s", r.TargetBranch)
	var out string
	out, err = gitClient.CheckoutOrOrphan(r.TargetBranch, false)
	if err != nil {
		return out, "", fmt.Errorf("failed to checkout sync branch: %w", err)
	}

	logCtx.Debug("Deleting files")
	err = DeletePaths(dirPath, r.Paths)
	if err != nil {
		return "", "", fmt.Errorf("failed to write files: %w", err)
	}

	logCtx.Debug("Committing and pushing changes")
	out, err = gitClient.CommitAndPush(r.TargetBranch, r.CommitMessage)
	if err != nil {
		return out, "", fmt.Errorf("failed to commit and push: %w", err)
	}

	logCtx.Debug("Getting commit SHA")
	sha, err := gitClient.CommitSHA()
	if err != nil {
		return "", "", fmt.Errorf("failed to get commit SHA: %w", err)
	}

	return "", sha, nil
}

func (s *Service) DeleteFiles(ctx context.Context, r *apiclient.DeleteFilesRequest) (*apiclient.DeleteFilesResponse, error) {
	logCtx := log.WithFields(log.Fields{"branch": r.TargetBranch, "repo": r.Repo.Repo})

	out, sha, err := s.handleDeleteRequest(ctx, logCtx, r)
	if err != nil {
		logCtx.WithError(err).WithField("output", out).Error("failed to handle delete files request")
		return &apiclient.DeleteFilesResponse{}, err
	}

	logCtx.Info("Successfully handled delete files request")
	return &apiclient.DeleteFilesResponse{
		CommitSha: sha,
	}, nil
}
