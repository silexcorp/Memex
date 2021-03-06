import React, { PureComponent } from 'react'
import Margin from 'src/dashboard-refactor/components/Margin'
import styled from 'styled-components'

import colors from '../../colors'
import { fonts } from '../../styles'

export interface SearchBarProps {
    onSearchBoxFocus(): void
    onSearchBarInputChange(
        event: { target: HTMLElement },
        inputString: string,
    ): void
    onSearchSubmit(event: { searchQuery: string }): void
    onSearchFiltersOpen(): void
    isSearchBoxSelected: boolean
    inputString?: string
}

const SearchBarContainer = styled.div`
    height: 34px;
    width: 650px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: ${colors.lightGrey};
    border-radius: 5px;
`

const fontStyles = `
    font-family: ${fonts.primary.name};
    font-style: normal;
    font-weight: ${fonts.primary.weight.bold};
`

const SearchHeader = styled.p`
    margin: 0;
    ${fontStyles}
    font-size: 12px;
    line-height: 18px;
`

const FilterButton = styled.p`
    margin: 0;
    ${fontStyles}
    font-size: 10px;
    line-height: 15px;
`

export default class SearchBar extends PureComponent<SearchBarProps> {
    render() {
        return (
            <Margin vertical="auto">
                <SearchBarContainer>
                    <Margin left="27px">
                        <SearchHeader>Search</SearchHeader>
                    </Margin>
                    <Margin right="23px">
                        <FilterButton>Filter</FilterButton>
                    </Margin>
                </SearchBarContainer>
            </Margin>
        )
    }
}
