package services

import (
	"context"
	"fmt"

	"github.com/argoproj/argo-cd/v2/pkg/apis/application/v1alpha1"
	repoapiclient "github.com/argoproj/argo-cd/v2/reposerver/apiclient"
	"github.com/argoproj/argo-cd/v2/util/db"
	ioutil "github.com/argoproj/argo-cd/v2/util/io"
)

// RepositoryDB Is a lean facade for ArgoDB,
// Using a lean interface makes it more easy to test the functionality the git generator uses
type RepositoryDB interface {
	GetRepository(ctx context.Context, url string) (*v1alpha1.Repository, error)
}

type argoCDService struct {
	repositoriesDB RepositoryDB
	repoClientSet  repoapiclient.Clientset
}

type Repos interface {

	// GetFiles returns content of files (not directories) within the target repo
	GetFiles(ctx context.Context, repoURL string, revision string, pattern string) (map[string][]byte, error)

	// GetDirectories returns a list of directories (not files) within the target repo
	GetDirectories(ctx context.Context, repoURL string, revision string) ([]string, error)
}

func NewArgoCDService(db db.ArgoDB, repoclientset repoapiclient.Clientset) Repos {

	return &argoCDService{
		repositoriesDB: db.(RepositoryDB),
		repoClientSet:  repoclientset,
	}
}

func (a *argoCDService) GetFiles(ctx context.Context, repoURL string, revision string, pattern string) (map[string][]byte, error) {
	repo, err := a.repositoriesDB.GetRepository(ctx, repoURL)
	if err != nil {
		return nil, fmt.Errorf("error in GetRepository: %w", err)
	}

	closer, repoClient, err := a.repoClientSet.NewRepoServerClient()
	if err != nil {
		return nil, err
	}
	defer ioutil.Close(closer)

	resp, err := repoClient.GetFiles(ctx, &repoapiclient.GetFilesRequest{
		Repo:     repo,
		Revision: revision,
		Pattern:  pattern,
	})
	if err != nil {
		return nil, err
	}

	return resp.Items, nil
}

func (a *argoCDService) GetDirectories(ctx context.Context, repoURL string, revision string) ([]string, error) {
	repo, err := a.repositoriesDB.GetRepository(ctx, repoURL)
	if err != nil {
		return nil, fmt.Errorf("error in GetRepository: %w", err)
	}

	closer, repoClient, err := a.repoClientSet.NewRepoServerClient()
	if err != nil {
		return nil, err
	}
	defer ioutil.Close(closer)

	resp, err := repoClient.GetDirectories(ctx, &repoapiclient.GetDirectoriesRequest{
		Repo:     repo,
		Revision: revision,
	})
	if err != nil {
		return nil, err
	}

	return resp.Items, nil
}
